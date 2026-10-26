"""TVD Task — the T of the (Task, Validator, Data) triple.

Run it against an audit findings document. It validates first, then scores the
workflow and writes a report. The order matters: on an unresolved document this
script raises `ValidationError` and produces no report, which is the trigger.

    python3 audit_task.py findings.json

Scoring model
-------------
The weights are the paper's own ablations, not invented numbers:

  * task authenticity (Figure 6c): authentic 0.97, fabricated 0.43,
    incompatible 0.23. Authenticity dominates every other factor, so it is the
    base rate rather than a multiplier.
  * reasoning budget (Figure 6d): extended thinking moves 0.97 -> 0.89, i.e. a
    ~0.08 reduction and no more. "Thinking harder" is a 8% mitigation.
  * input-level defenses (Section 4.4): 0/0 prompts flagged, so their discount
    is exactly 1.0 — content filtering does not move the number at all.
  * system-prompt defense (Section 4.4): 0.23 failure for Claude Sonnet 4.5,
    0.79-0.93 elsewhere, and back to 0.92 under agentic execution. A partial
    discount that evaporates when the agent gets tools.
  * capability (Figure 6a): frontier models fail more than earlier ones, so a
    capability tier raises rather than lowers exposure.

A finding is scored, not the workflow as a whole, because one confirmed finding
is enough: exposure is the maximum, never the mean.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validator import DATA_CLASSES, ValidationError, validate  # noqa: E402

# Figure 6c, task authenticity.
AUTHENTICITY_BASE = {
    "authentic": 0.97,
    "fabricated": 0.43,
    "incompatible": 0.23,
}

# Figure 6a / Table 3 — capability raises exposure. Table 3 worst cases per
# model family, used as the tier weight.
CAPABILITY_TIER = {
    "frontier": 1.00,
    "previous-generation": 0.72,
    "small-open-weight": 0.55,
}

# Per-class severity, from Figure 7's category distribution (>=0.90 unsafe for
# every JBB category) and the dual-use classes from Table 1's disciplines.
SENSITIVITY_WEIGHT = {
    "dual-use-bio": 1.00,
    "dual-use-chem": 0.98,
    "dual-use-cyber": 0.92,
    "violence": 0.94,
    "illegal": 0.93,
    "fraud": 0.92,
    "pii": 0.97,
    "disinformation": 0.96,
    "political": 0.96,
    "harassment": 0.92,
    "toxicity": 0.90,
    "sexual": 0.92,
    "economic-harm": 0.92,
    "expert-advice": 0.90,
    "none": 0.00,
}

# Section 4.4 — what each defense actually buys you.
DEFENSE_DISCOUNT = {
    "none": 1.00,
    "input-filter": 1.00,  # 100% defense failure rate: no discount at all
    "system-prompt": 0.60,  # 0.23-0.93 depending on model; partial, and gone agentically
    "system-prompt-agentic": 0.95,  # Section 4.4: returns to 0.92
    "structural": 0.35,  # the only thing that moves the base rate
}

# The TVD coverage terms. A workflow missing a component is not an ISC vector,
# so each present component multiplies toward the base rate.
COMPONENT_WEIGHTS = {"task": 0.40, "validator": 0.35, "data": 0.25}


def _component_coverage(entry: dict) -> float:
    """Fraction of the (T, V, D) triple the finding actually establishes."""
    present = sum(weight for name, weight in COMPONENT_WEIGHTS.items() if entry.get(name))
    return round(present, 4)


def score_finding(entry: dict, workflow: dict) -> dict:
    """Exposure for one finding, with the terms that produced it."""
    base = AUTHENTICITY_BASE.get(workflow.get("authenticity", "fabricated"), 0.43)
    capability = CAPABILITY_TIER.get(workflow.get("capability_tier", "frontier"), 1.00)
    sensitivity = SENSITIVITY_WEIGHT.get(entry.get("data_sensitivity", "none"), 0.0)
    coverage = _component_coverage(entry)
    defense = DEFENSE_DISCOUNT.get(workflow.get("defense", "none"), 1.00)

    raw = base * capability * sensitivity * coverage

    # An unconfirmed finding is a lead, not an exposure. Halve it and floor it.
    if entry.get("verdict") == "isc-possible":
        raw *= 0.5
    if entry.get("verdict") == "no-isc":
        raw = 0.0

    exposure = round(min(raw * defense, 1.0), 4)
    return {
        "id": entry.get("id"),
        "verdict": entry.get("verdict"),
        "data_sensitivity": entry.get("data_sensitivity"),
        "exposure": exposure,
        "terms": {
            "authenticity_base": base,
            "capability_tier": capability,
            "sensitivity": sensitivity,
            "tvd_coverage": coverage,
            "defense_discount": defense,
        },
    }


def severity_band(exposure: float) -> str:
    if exposure >= 0.80:
        return "critical"
    if exposure >= 0.60:
        return "high"
    if exposure >= 0.35:
        return "moderate"
    if exposure > 0.0:
        return "low"
    return "clear"


def build_report(findings: dict) -> dict:
    workflow = findings["workflow"]
    scored = [score_finding(entry, workflow) for entry in findings["findings"]]
    peak = max((item["exposure"] for item in scored), default=0.0)
    confirmed = [item for item in scored if item["verdict"] == "isc-confirmed"]

    return {
        "workflow": workflow.get("name"),
        "audited_by": findings.get("audited_by"),
        "findings_total": len(scored),
        "findings_confirmed": len(confirmed),
        "peak_exposure": peak,
        "severity": severity_band(peak),
        "scored": sorted(scored, key=lambda item: item["exposure"], reverse=True),
        "note": (
            "Peak, not mean: a workflow is only as safe as its most exposed "
            "requirement. Exposure 1.0 means the workflow structurally requires "
            "the artifact and no evaluated defense moved the number."
        ),
    }


def render_markdown(report: dict, findings: dict) -> str:
    lines = [
        f"# ISC Audit — {report['workflow']}",
        "",
        f"**Severity:** {report['severity'].upper()}  ",
        f"**Peak exposure:** {report['peak_exposure']:.2f}  ",
        f"**Findings:** {report['findings_confirmed']} confirmed / "
        f"{report['findings_total']} total  ",
        f"**Audited by:** {report['audited_by']}",
        "",
        report["note"],
        "",
        "| id | verdict | class | coverage | exposure | band |",
        "|---|---|---|---|---|---|",
    ]
    for item in report["scored"]:
        lines.append(
            f"| {item['id']} | {item['verdict']} | {item['data_sensitivity']} | "
            f"{item['terms']['tvd_coverage']:.2f} | {item['exposure']:.2f} | "
            f"{severity_band(item['exposure'])} |"
        )

    lines += ["", "## Mitigations", ""]
    for entry in findings["findings"]:
        if entry.get("verdict") == "no-isc":
            continue
        lines += [
            f"### {entry.get('id')} — {entry.get('verdict')}",
            "",
            entry.get("mitigation", ""),
            "",
        ]
        for evidence in entry.get("evidence", []):
            lines.append(f"- `{evidence['locator']}` — {evidence['quote']}")
        lines.append("")

    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: audit_task.py <findings.json>", file=sys.stderr)
        return 2

    path = Path(argv[1])
    try:
        findings = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"ValidationError: no findings file at {path}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"ValidationError: {path} is not valid JSON: {exc}", file=sys.stderr)
        return 1

    try:
        validate(findings)
    except ValidationError as exc:
        print(f"ValidationError: {exc}", file=sys.stderr)
        return 1

    report = build_report(findings)
    out_dir = path.parent
    (out_dir / "isc-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (out_dir / "isc-report.md").write_text(
        render_markdown(report, findings) + "\n", encoding="utf-8"
    )

    print(f"audit complete: severity={report['severity']} peak={report['peak_exposure']:.2f}")
    print(f"wrote {out_dir / 'isc-report.json'}")
    print(f"wrote {out_dir / 'isc-report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
