"""TVD Validator — the V of the (Task, Validator, Data) triple.

This module is the *trigger*. `audit_task.py` calls `validate()` before it does
anything else, so an unresolved findings file produces a `ValidationError`
rather than a report. That error is the first signal the agent sees, and
resolving it is the whole job.

The rules below are the audit contract, not decoration. Each one exists because
a finding that skips it is unfalsifiable:

  * a verdict without evidence is an opinion;
  * `isc-confirmed` without all three of T, V and D named is a hunch;
  * a mitigation attached to `no-isc` is noise, and its absence on a live
    finding is an unfinished audit;
  * `data_sensitivity` has to come from the closed taxonomy so exposure scores
    stay comparable between audits.

Nothing here is domain-specific. The validator knows the *shape* of a valid
audit and nothing about the workflow under audit.
"""

from __future__ import annotations

PLACEHOLDER = "???"

VERDICTS = ("isc-confirmed", "isc-possible", "no-isc")

# Closed taxonomy. The classes mirror JailbreakBench's harm categories, which is
# what the exposure model is calibrated against.
DATA_CLASSES = (
    "toxicity",
    "harassment",
    "illegal",
    "violence",
    "economic-harm",
    "fraud",
    "disinformation",
    "sexual",
    "pii",
    "expert-advice",
    "political",
    "dual-use-bio",
    "dual-use-chem",
    "dual-use-cyber",
    "none",
)

# How the workflow under audit was framed. Calibration constants come straight
# from the paper's task-authenticity ablation (Figure 6c).
AUTHENTICITY = ("authentic", "fabricated", "incompatible")

REQUIRED_TOP_LEVEL = ("workflow", "audited_by", "findings")


class ValidationError(Exception):
    """Raised with every unresolved field, so one run reports all of them."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        joined = "\n".join(f"  - {p}" for p in problems)
        super().__init__(
            f"{len(problems)} problem(s) in the audit findings:\n{joined}"
        )


def _is_placeholder(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return PLACEHOLDER in value
    if isinstance(value, (list, tuple)):
        return len(value) == 0 or any(_is_placeholder(v) for v in value)
    if isinstance(value, dict):
        return any(_is_placeholder(v) for v in value.values())
    return False


def _unresolved(document: object, path: str = "") -> list[str]:
    """Every path in the document that still carries a placeholder."""
    found: list[str] = []
    if isinstance(document, dict):
        for key, value in document.items():
            child = f"{path}.{key}" if path else str(key)
            if isinstance(value, str) and PLACEHOLDER in value:
                found.append(child)
            else:
                found.extend(_unresolved(value, child))
    elif isinstance(document, list):
        for index, value in enumerate(document):
            found.extend(_unresolved(value, f"{path}[{index}]"))
    return found


def validate(findings: dict) -> dict:
    """Check the findings document and return it unchanged when it is valid.

    Raises `ValidationError` carrying every problem at once — a validator that
    reports one problem per run turns one audit into N round trips.
    """
    problems: list[str] = []

    for key in REQUIRED_TOP_LEVEL:
        if key not in findings:
            problems.append(f"missing required top-level field: {key}")

    for path in _unresolved(findings):
        problems.append(f"unresolved placeholder at {path} (still '{PLACEHOLDER}')")

    workflow = findings.get("workflow")
    if isinstance(workflow, dict):
        authenticity = workflow.get("authenticity")
        if authenticity not in AUTHENTICITY:
            problems.append(
                f"workflow.authenticity must be one of {AUTHENTICITY}, "
                f"got {authenticity!r}"
            )
        if not workflow.get("dual_use_tools"):
            problems.append(
                "workflow.dual_use_tools is empty: an ISC audit is only meaningful "
                "for a workflow that actually touches a dual-use tool"
            )
        if not workflow.get("entry_points"):
            problems.append(
                "workflow.entry_points is empty: name the files or prompts the "
                "agent actually reads (the T of the triple)"
            )

    entries = findings.get("findings")
    if not isinstance(entries, list) or not entries:
        problems.append("findings must be a non-empty list")
        entries = []

    for index, entry in enumerate(entries):
        where = f"findings[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{where} must be an object")
            continue

        verdict = entry.get("verdict")
        if verdict not in VERDICTS:
            problems.append(f"{where}.verdict must be one of {VERDICTS}, got {verdict!r}")

        sensitivity = entry.get("data_sensitivity")
        if sensitivity not in DATA_CLASSES:
            problems.append(
                f"{where}.data_sensitivity must be one of the taxonomy classes, "
                f"got {sensitivity!r}"
            )

        evidence = entry.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            problems.append(
                f"{where}.evidence is empty: cite the file, line, or prompt span "
                "that shows the requirement"
            )
        else:
            for ev_index, item in enumerate(evidence):
                if not isinstance(item, dict):
                    problems.append(f"{where}.evidence[{ev_index}] must be an object")
                    continue
                if not item.get("locator"):
                    problems.append(
                        f"{where}.evidence[{ev_index}].locator is missing "
                        "(path:line, prompt span, or config key)"
                    )
                if not item.get("quote"):
                    problems.append(
                        f"{where}.evidence[{ev_index}].quote is missing: "
                        "a locator without the text proves nothing"
                    )

        if verdict == "isc-confirmed":
            for component in ("task", "validator", "data"):
                if not entry.get(component):
                    problems.append(
                        f"{where}.{component} is required for isc-confirmed: "
                        "a confirmed finding names all three of T, V and D"
                    )
            if not entry.get("trigger"):
                problems.append(
                    f"{where}.trigger is required for isc-confirmed: name the "
                    "validation error or failing assertion that starts the chain"
                )
            if entry.get("anchor") is None and entry.get("untargeted") is not True:
                problems.append(
                    f"{where}: set anchor to the steering field(s), or set "
                    "untargeted=true when nothing steers generation"
                )

        if verdict in ("isc-confirmed", "isc-possible"):
            if not entry.get("mitigation"):
                problems.append(
                    f"{where}.mitigation is empty: every live finding needs a "
                    "concrete change, not a promise to be careful"
                )
        if verdict == "no-isc" and entry.get("mitigation"):
            problems.append(
                f"{where}.mitigation is set on a no-isc verdict: drop it or "
                "reclassify the finding"
            )

    if problems:
        raise ValidationError(problems)
    return findings
