"""
Shared content for both POLYTOS manuals.

Figure numbering, screenshot resolution, the glossary, and the facts about the
demonstration organisation that both manuals quote. Everything here is read
from the captured screenshot library and the verification data, so a figure
reference that has no photograph behind it is reported rather than printed as
a working reference.
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SHOTS = os.path.join(ROOT, "docs", "POLYTOS-Manuals", "03-Screenshots")

MISSING: list[str] = []
USED: list[str] = []


# The committed library is JPEG: 843 lossless captures came to 573 MB, which is
# not a thing to put in a repository, and at quality 85 and 1440 pixels wide a
# screenshot of an interface is indistinguishable from the original. The
# capture scripts still produce PNG, and both are resolved here so the library
# can be regenerated at full fidelity without changing a line of the manuals.
EXTENSIONS = (".jpg", ".png")


def shot(viewport: str, module: str, name: str, role: str | None = None,
         full: bool = False) -> str:
    """Resolve a screenshot path, recording anything that is not there."""
    folder = os.path.join(SHOTS, viewport, module)
    for ext in EXTENSIONS:
        suffix = f".full{ext}" if full else ext
        found = _find(folder, name, role, suffix)
        if found is not None:
            USED.append(found)
            return found
    path = os.path.join(folder, f"{name}--{role or 'owner'}{EXTENSIONS[0]}")
    MISSING.append(os.path.relpath(path, ROOT))
    return path


def _find(folder: str, name: str, role: str | None, suffix: str) -> str | None:
    """The walk-through scripts name a step; the sweep names a screen and a role."""
    bare = os.path.join(folder, f"{name}{suffix}")
    if os.path.exists(bare):
        return bare
    if role is not None:
        exact = os.path.join(folder, f"{name}--{role}{suffix}")
        if os.path.exists(exact):
            return exact
    if os.path.isdir(folder):
        for candidate in sorted(os.listdir(folder)):
            if candidate.startswith(f"{name}--") and candidate.endswith(suffix):
                if suffix.startswith(".full") or ".full." not in candidate:
                    return os.path.join(folder, candidate)
    return None


def _shot_unused(viewport: str, module: str, name: str, role: str | None = None,
                 full: bool = False) -> str:
    folder = os.path.join(SHOTS, viewport, module)
    suffix = ".full.png" if full else ".png"
    # The walk-through scripts photograph one named step rather than one screen
    # per role, so their files carry no role suffix at all.
    bare = os.path.join(folder, f"{name}{suffix}")
    if os.path.exists(bare):
        USED.append(bare)
        return bare
    if role is not None:
        path = os.path.join(folder, f"{name}--{role}{suffix}")
        if os.path.exists(path):
            USED.append(path)
            return path
    if os.path.isdir(folder):
        for candidate in sorted(os.listdir(folder)):
            stem = f"{name}--"
            if candidate.startswith(stem) and candidate.endswith(suffix):
                if full or not candidate.endswith(".full.png"):
                    path = os.path.join(folder, candidate)
                    USED.append(path)
                    return path
    path = os.path.join(folder, f"{name}--{role or 'owner'}{suffix}")
    MISSING.append(os.path.relpath(path, ROOT))
    return path


def D(module: str, name: str, role: str | None = None, full: bool = False) -> str:
    return shot("Desktop", module, name, role, full)


def M(module: str, name: str, role: str | None = None, full: bool = False) -> str:
    return shot("Mobile", module, name, role, full)


class Figures:
    """Chapter-scoped figure numbering: Figure 4.3, Figure 4.4, ..."""

    def __init__(self) -> None:
        self.chapter = 0
        self.n = 0
        self.index: list[tuple[str, str]] = []

    def chapter_is(self, number: int) -> None:
        self.chapter = number
        self.n = 0

    def next(self, caption: str) -> str:
        self.n += 1
        label = f"Figure {self.chapter}.{self.n} — {caption}"
        self.index.append((f"{self.chapter}.{self.n}", caption))
        return label


class Tables:
    def __init__(self) -> None:
        self.chapter = 0
        self.n = 0

    def chapter_is(self, number: int) -> None:
        self.chapter = number
        self.n = 0

    def next(self, caption: str) -> str:
        self.n += 1
        return f"Table {self.chapter}.{self.n} — {caption}"


# ===========================================================================
# The demonstration organisation
# ===========================================================================
ORG = "POLYTOS Demonstration Enterprise"

BRANCHES = [
    ("BR2601", "Kampala Main Branch", "Plot 27, Kampala Road", "Kampala", "5 January 2026"),
    ("BR2602", "Mbarara Branch", "Plot 8, High Street", "Mbarara", "2 February 2026"),
    ("BR2603", "Masaka Branch", "Plot 3, Elgin Street", "Masaka", "13 April 2026"),
]

PEOPLE = [
    ("Nalubega Sarah Kiwanuka", "Owner / Administrator", "+256 772 100 101", "Kampala Main"),
    ("Ssekandi Joseph Mukasa", "Owner / Administrator", "+256 772 900 201", "Kampala Main"),
    ("Okello Daniel Omara", "Manager", "+256 772 100 102", "Kampala Main"),
    ("Namirembe Grace Atim", "Secretary / Treasurer", "+256 772 100 103", "Kampala Main"),
    ("Wasswa Peter Lubega", "Secretary / Treasurer", "+256 772 100 104", "Kampala Main"),
    ("Akello Betty Anyango", "Secretary / Treasurer (suspended)", "+256 772 100 105", "Kampala Main"),
    ("Mugisha Robert Tumwine", "Client (borrower portal)", "+256 772 110 008", "Kampala Main"),
]

ROLE_SUMMARY = [
    ("Client", "client", 10, "No",
     "A borrower. Sees only their own loans, schedule and payments, through the client portal."),
    ("Secretary / Treasurer", "secretary_treasurer", 30, "Yes",
     "Front-office staff. Registers clients, members and guarantors, records payments, takes "
     "savings deposits, records agency transactions and prepares applications."),
    ("Manager", "manager", 50, "Yes",
     "Supervises operations. Approves loans, verifies agency transactions, applies penalties, "
     "decides transfers and expenses, performs reconciliation and reads every report."),
    ("Owner / Administrator", "owner_admin", 70, "Yes",
     "Full control, including business settings, user management, provider configuration, "
     "capital, settlement, reversal and the audit trail."),
]

GLOSSARY = [
    ("Agent line / till",
     "A named counter position registered against one provider at one branch — for example "
     "*Mbarara MTN Till 1*. It owns one electronic float account in the ledger, and only the "
     "staff authorised on it may trade it."),
    ("Agency banking",
     "Acting as the over-the-counter agent of a partner bank, so a customer can pay money into "
     "or take money out of their bank account at a POLYTOS counter."),
    ("Approval threshold",
     "An amount above which a transaction may only be verified by somebody holding a higher "
     "authority. Configured per service."),
    ("Arrears",
     "Money a borrower should have paid by today and has not."),
    ("Business day",
     "The trading date POLYTOS posts against, shown in the top bar. It is not always the "
     "calendar date on your device."),
    ("Capability",
     "A named permission such as `payments:create`. Roles are built out of capabilities; screens "
     "and the database both check the same ones."),
    ("Cash at hand",
     "Physical money in the branch till, account code `1010` with the branch code appended."),
    ("Cash basis",
     "Income is recognised when the money is collected, not when it is charged. POLYTOS keeps "
     "its books this way, so charging a penalty posts nothing until it is paid."),
    ("Commission",
     "What the provider pays POLYTOS for handling a transaction. It is **never** part of the "
     "principal the customer moved, and it never increases float until it is settled."),
    ("Commission receivable",
     "Commission POLYTOS has earned but the provider has not yet remitted. Account `1310`."),
    ("Deferred commission",
     "Commission recognised as income at the moment of the transaction and collected later. The "
     "opposite model, *immediate*, takes the commission out of the same transaction."),
    ("Double entry",
     "Every posting moves money between at least two accounts, and the debits always equal the "
     "credits. POLYTOS refuses to write an entry that does not balance."),
    ("Float",
     "Electronic value held with a provider — MTN, Airtel or a partner bank — which the counter "
     "spends when a customer deposits and receives when a customer withdraws. Account series "
     "`1320`."),
    ("Float replenishment",
     "Buying more electronic float, paid for out of cash or a bank account."),
    ("Journal entry",
     "One balanced posting in the general ledger. Entries are append-only: a mistake is "
     "corrected by a reversal, never by an edit."),
    ("Ledger account",
     "One line of the chart of accounts, identified by a code such as `4510`."),
    ("Maker-checker",
     "The rule that the person who records something may not be the person who approves it. "
     "POLYTOS enforces it as a database constraint, so no screen can skip it."),
    ("Payable",
     "Money POLYTOS is holding that belongs to somebody else — a school's fees, a partner "
     "bank's deposits. It is a liability, not income. Account series `2200`."),
    ("Posting",
     "Writing the journal entry. In POLYTOS most financial documents are recorded first and "
     "post only when a second person verifies them."),
    ("Principal",
     "The amount the customer actually moved, excluding any fee or commission."),
    ("Reconciliation",
     "Comparing what POLYTOS says a balance is against an independent count or statement, "
     "explaining the difference, and having a second person approve the result."),
    ("Reversal",
     "A contra posting that undoes an earlier one. The original entry stays on the record."),
    ("Row Level Security",
     "The database's own access rules. They apply to every route into the data, so hiding a "
     "button is never how POLYTOS protects anything."),
    ("Settlement",
     "The provider actually paying over the commission it owed, or POLYTOS paying over the cash "
     "it held on somebody's behalf."),
    ("Trial balance",
     "A list of every account's balance, proving that total debits equal total credits."),
    ("UGX",
     "Uganda Shillings. POLYTOS stores every amount as a whole number of shillings — there are "
     "no cents."),
    ("Variance",
     "The difference between a counted or stated balance and what POLYTOS says it should be."),
]


def ugx(n) -> str:
    return f"UGX {int(n):,}"


def load_json(name: str, default=None):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        return default
    with open(path) as fh:
        return json.load(fh)
