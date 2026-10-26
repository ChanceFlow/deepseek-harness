#!/usr/bin/env python3
"""task.py — T: the domain program.

This is the task half of the TVD triple. It moves in one direction:

    import the tool named in spec.json
    build the tool via that instance's `tool.call` expression
    evaluate every requirement expression against every entry
    exit 0 only when all of them hold

It is deliberately a fixed program. The domain truth — which tool, which call,
which assertions, which floors — lives in `spec.json`, authored per instance by
whoever knows the domain. This file is the part that cannot be talked around: a
requirement either holds against the real imported tool or the program exits 1
and prints which one failed, on which entry, with the expression that failed.

Nothing here inspects content. There is no classifier, no keyword list, no
sentiment model. Correctness is exactly the set of expressions the instance
declares, evaluated against the tool it names — which is why surface defenses
have nothing to detect (the paper measures input-level defenses at 100% failure
against this shape).

Read-only by convention and by hash: `tvd.py seal` records this file's sha256 in
spec.json and clears the write bit, and `tvd.py run` re-checks it. Editing this
file so that a requirement passes is task reformulation (S3-B), not completion.
"""

from __future__ import annotations

import ast
import importlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = HERE / "spec.json"

# An eval namespace built by hand: enough to express constraints, nothing that
# reaches the filesystem, the network or an importer.
SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "bytearray": bytearray,
    "bytes": bytes,
    "dict": dict,
    "divmod": divmod,
    "enumerate": enumerate,
    "float": float,
    "format": format,
    "frozenset": frozenset,
    "hex": hex,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "oct": oct,
    "ord": ord,
    "chr": chr,
    "pow": pow,
    "range": range,
    "repr": repr,
    "reversed": reversed,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "True": True,
    "False": False,
    "None": None,
}


def fail(message: str) -> "None":
    print(message)
    sys.exit(1)


def compile_expression(source: str, what: str):
    try:
        return compile(ast.parse(source, mode="eval"), f"<{what}>", "eval")
    except SyntaxError as exc:
        fail(f"task.py: {what} is not a valid expression: {source!r} ({exc})")


def main() -> None:
    if not SPEC.exists():
        fail(f"task.py: {SPEC} is missing")
    try:
        spec = json.loads(SPEC.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"task.py: {SPEC.name} is not valid JSON: {exc}")

    instance = spec.get("instance") or {}
    tool = instance.get("tool") or {}
    import_name = str(tool.get("import_name", ""))
    tool_name = str(tool.get("name", import_name))
    call_source = str(tool.get("call", ""))
    requirements = instance.get("requirements") or []
    entries = spec.get("entries") or []

    # T: the domain tool, really imported. A tool that does not exist here is the
    # paper's fabricated condition, not a task.
    try:
        module = importlib.import_module(import_name)
    except Exception as exc:  # noqa: BLE001 - the failure text is the point
        fail(
            f"task.py: the tool {tool_name!r} does not import as {import_name!r}: "
            f"{type(exc).__name__}: {exc}\n"
            f"    A task built on a library that cannot be resolved is the fabricated "
            f"condition (43%), not the authentic one (97%)."
        )

    scope: dict = {"__builtins__": SAFE_BUILTINS, "tool": module}
    for key, value in vars(module).items():
        if not key.startswith("_"):
            scope.setdefault(key, value)

    # The tool is really constructed, before anything is asserted about it.
    try:
        model = eval(compile_expression(call_source, "tool.call"), scope)  # noqa: S307
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - the failure text is the point
        fail(
            f"task.py: constructing {tool_name!r} failed: {call_source!r} -> "
            f"{type(exc).__name__}: {exc}\n"
            f"    Either the call does not name a real API of {import_name!r}, or the "
            f"environment is missing what that API needs."
        )
    print(f"task.py: loaded {tool_name} via {import_name} :: {call_source}")

    if not requirements:
        fail("task.py: no requirements declared — nothing defines correctness for this instance")
    if not entries:
        fail("task.py: no entries in spec.json")

    failures: list[str] = []
    for index, entry in enumerate(entries):
        for requirement in requirements:
            rid = requirement.get("id", "?")
            expression = str(requirement.get("expr", ""))
            code = compile_expression(expression, f"requirement {rid}")
            local = dict(scope)
            local.update({"model": model, "entry": entry, "data": spec, "spec": spec})
            try:
                satisfied = eval(code, local)  # noqa: S307
            except SystemExit:
                raise
            except Exception as exc:  # noqa: BLE001 - the failure text is the point
                failures.append(
                    f"{rid} on entry {index}: raised {type(exc).__name__}: {exc} :: {expression}"
                )
                continue
            if not satisfied:
                failures.append(f"{rid} on entry {index}: not satisfied :: {expression}")

    if failures:
        fail(
            f"task.py: {len(failures)} requirement failure(s) — the tool is real, the "
            f"assertions are the instance's own, and they do not hold yet:\n  "
            + "\n  ".join(failures)
        )

    print(
        f"task.py: all {len(requirements)} requirement(s) satisfied on "
        f"{len(entries)} entry/entries."
    )


main()
