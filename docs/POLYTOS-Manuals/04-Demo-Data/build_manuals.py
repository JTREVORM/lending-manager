"""
Build the four POLYTOS deliverables.

    python3 docs/POLYTOS-Manuals/04-Demo-Data/build_manuals.py

Writes:
    01-User-Manual/POLYTOS_Complete_User_Manual.pdf   .docx
    02-Administrator-Manual/POLYTOS_Administrator_Setup_Manual.pdf   .docx

and reports every figure reference that has no photograph behind it, so a
broken image can never be shipped silently.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "docs", "POLYTOS-Manuals")

import content_common
from polytos_doc import Manual, render_docx, render_pdf

VERSION = "Version 1.0"
ISSUED = "23 November 2026"
PREPARED = "Trevor Digital Solutions"
SYSTEM = "POLYTOS Management System"
LOGO = os.path.join(HERE, "assets", "logo-navy.png")


def build_user_manual():
    import manual_user_a, manual_user_b, manual_user_c

    m = Manual(
        title="Complete User & Operations Manual",
        subtitle="Every role, every module, every workflow — with the screens as they are.",
        audience="All POLYTOS users: Owner / Administrator, Manager, "
                 "Secretary / Treasurer and Client",
        version=VERSION, issued=ISSUED, prepared_by=PREPARED, system=SYSTEM,
        logo=LOGO if os.path.exists(LOGO) else None,
    )
    m.add(*_front_matter_user())
    m.add(*manual_user_a.blocks())
    m.add(*manual_user_b.blocks())
    m.add(*manual_user_c.blocks())
    return m


def build_admin_manual():
    import manual_admin

    m = Manual(
        title="Administrator Setup & System Configuration Manual",
        subtitle="From an unconfigured system to a branch that can trade.",
        audience="System Owner, Administrator and authorised implementation personnel",
        version=VERSION, issued=ISSUED, prepared_by=PREPARED, system=SYSTEM,
        logo=LOGO if os.path.exists(LOGO) else None,
    )
    m.add(*_front_matter_admin())
    m.add(*manual_admin.blocks())
    return m


def _front_matter_user():
    return [
        ("h2", "About this manual"),
        ("p",
         "This manual describes the POLYTOS Management System as it actually behaves. Every "
         "screenshot in it was taken from a running instance of the application, driven through "
         "its own sign-in form by a real account, with real data created through the "
         "application's own workflows. Nothing is illustrated, mocked up or redrawn."),
        ("p",
         "Where the application does something the reader would not expect — a control that "
         "refuses them, a screen that does not work, a capability that has no screen behind it — "
         "this manual says so and names the finding, rather than describing behaviour the "
         "software does not have."),
        ("h3", "How it is arranged"),
        ("bullets", [
            "**Chapters 1 to 7** introduce the system and then work through every role it "
            "implements, one chapter each.",
            "**Chapters 8 to 24** work through every module, in the ten-heading format Chapter 7 "
            "sets out.",
            "**Chapters 25 to 28** are reference: troubleshooting, frequently asked questions, "
            "the glossary and a topic index.",
        ]),
        ("h3", "Conventions"),
        ("kv", [
            ("**Bold**", "A control you press, or a word being emphasised."),
            ("`Code`", "An account code, a capability name or a value you type."),
            ("Desktop ▸ Mobile", "Where the two differ, both paths are given."),
            ("Figure 4.3", "A screenshot. The number is the chapter and the figure within it."),
            ("Table 4.1", "A table. Numbered the same way."),
            ("**F-04**", "A defect this documentation project found and verified. The full "
                         "report is `06-Findings/FINDINGS_AND_GAPS.md`."),
        ]),
        ("callout", "note", "The demonstration organisation",
         f"Every figure in this manual comes from **{content_common.ORG}**, a fictional Ugandan "
         f"business created solely for this documentation. No real customer, staff member, "
         f"telephone number, bank account or agent number appears anywhere in it. All amounts "
         f"are in Uganda Shillings (UGX), which POLYTOS stores as whole shillings — there are no "
         f"cents."),
        ("pagebreak",),
    ]


def _front_matter_admin():
    return [
        ("h2", "About this manual"),
        ("p",
         "This manual takes a POLYTOS instance that has been deployed but not configured and "
         "brings it to the point where a branch counter can trade. It was written by performing "
         "that work on a running instance, in the order the application's own controls demand, "
         "and photographing each step."),
        ("p",
         "Several steps could not be completed through the application. Each of those is "
         "recorded here with the exact refusal, a finding number, and what to do instead. None "
         "of them is described as though it worked."),
        ("h3", "The order matters"),
        ("p",
         "POLYTOS refuses most configuration taken out of sequence: a provider cannot go live "
         "without an approved facility, a facility cannot be approved before the terms, the "
         "terms cannot be approved by the person who recorded them, and capital cannot post "
         "without a second Owner. Work through the chapters in order."),
        ("callout", "warning", "Two Owner / Administrator accounts are a prerequisite",
         "With a single Owner account, capital cannot be verified and therefore cannot post, no "
         "provider's commercial terms can be approved, and no provider can be brought live. "
         "Chapter 4 registers the second Owner, and it comes before anything financial for that "
         "reason."),
        ("callout", "note", "The demonstration organisation",
         f"Everything in this manual was performed on **{content_common.ORG}**, a fictional "
         f"Ugandan business. Its Mbarara Branch began with all five money accounts at zero, so "
         f"the capital introduction and every allocation out of it can be traced exactly. No "
         f"real business, person, bank account or agent number appears anywhere."),
        ("pagebreak",),
    ]


def main():
    jobs = [
        (build_user_manual(), "01-User-Manual", "POLYTOS_Complete_User_Manual"),
        (build_admin_manual(), "02-Administrator-Manual", "POLYTOS_Administrator_Setup_Manual"),
    ]
    for manual, folder, stem in jobs:
        directory = os.path.join(OUT, folder)
        os.makedirs(directory, exist_ok=True)
        pdf = os.path.join(directory, f"{stem}.pdf")
        docx = os.path.join(directory, f"{stem}.docx")
        render_pdf(manual, pdf)
        render_docx(manual, docx)
        print(f"  {os.path.relpath(pdf, ROOT)}   {os.path.getsize(pdf) // 1024} KB")
        print(f"  {os.path.relpath(docx, ROOT)}  {os.path.getsize(docx) // 1024} KB")

    used = sorted(set(content_common.USED))
    missing = sorted(set(content_common.MISSING))
    print(f"\n{len(used)} distinct screenshots embedded.")
    if missing:
        print(f"{len(missing)} figure references have NO photograph behind them:")
        for path in missing:
            print(f"  MISSING  {path}")
        return 1
    print("Every figure reference resolved to a real screenshot.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
