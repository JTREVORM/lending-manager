"""
POLYTOS Administrator Setup & System Configuration Manual.

Fifteen chapters from an unconfigured system to a branch that can trade.
Everything in it was performed on a running POLYTOS instance by
`administrator-setup-walkthrough.mjs` and `operations-walkthrough.mjs`, and
the screenshots are of those runs.
"""

from content_common import (
    BRANCHES, D, GLOSSARY, M, ORG, PEOPLE, ROLE_SUMMARY, Figures, Tables,
    load_json, ugx,
)

F = Figures()
T = Tables()

WALK = load_json("walkthrough-result.json", {}) or {}
OPS_RESULT = load_json("operations-result.json", {}) or {}


def W(name):
    return D("18-Walkthrough", name)


def WM(name):
    return M("18-Walkthrough", name)


def O(name):
    return D("19-Operations", name)


def OM(name):
    return M("19-Operations", name)


def blocks():
    B = []
    add = B.append

    # =======================================================================
    # CHAPTER 1
    # =======================================================================
    F.chapter_is(1); T.chapter_is(1)
    add(("chapter", 1, "Installation and first access",
         "What has to exist before POLYTOS can be configured, how the first administrator gets "
         "in, and what to check before touching anything."))

    add(("lead",
         "This manual takes a POLYTOS instance that has nothing in it but its reference data and "
         "brings it to the point where a branch counter can trade. Work through it in order: "
         "the dependencies are real, and POLYTOS refuses most steps taken out of sequence."))

    add(("h2", "1.1  What you need before you start"))
    add(("table", ["", "What", "Why"],
         [
             ["Application", "A deployed POLYTOS instance and its web address",
              "Everything in this manual is done through it"],
             ["Database", "A PostgreSQL database with every migration applied",
              "The roles, capabilities, chart of accounts and reference data come from the "
              "migrations, not from this manual"],
             ["First account", "One Owner / Administrator account",
              "There is no self-registration; the first account is created during deployment"],
             ["**Second Owner**", "A second Owner / Administrator account",
              "**Several steps refuse the person who performed the previous one.** With one "
              "Owner, capital cannot be posted and no provider can be brought live"],
             ["Branches", "At least one branch with its five money accounts",
              "Cash belongs to a branch. See §3"],
             ["Evidence", "Bank advices, signed agency agreements, facility letters",
              "POLYTOS records the reference of each; it does not hold the documents"],
         ],
         T.next("The prerequisites for configuring a new organisation.")))
    add(("callout", "warning", "Never publish credentials",
         "No password, API key, database URL or connection string appears anywhere in this "
         "manual, and none should appear in any copy of it you distribute. The first "
         "administrator's credentials are handed over out of band and changed at first sign-in."))

    add(("h2", "1.2  First sign-in"))
    add(("figure", D("01-Access", "login", "anon"),
         F.next("The sign-in screen (desktop)"),
         "Sign-in is by **telephone number** and password. The product name and strapline on "
         "this screen come from the application's own branding, not from your organisation's "
         "settings — your organisation's name appears after you sign in."))
    add(("steps", [
        ("Open the address and sign in with the first administrator's credentials.",
         "If the password was issued as temporary, you are taken straight to the password screen."),
        ("Change the password.", "You cannot reach any other screen until you have."),
        ("Check the top bar.",
         "It should name your organisation and show today's business day. If it names somebody "
         "else's organisation you are on the wrong instance — stop."),
        ("Open **Finance ▸ Trial Balance**.",
         "On an unconfigured instance this is empty or shows only the opening position. Debits "
         "must equal credits before you record anything."),
        ("Open **Administration ▸ Company Settings**.",
         "The organisation's own details, the lending rules, the guarantor rules, the finance "
         "settings and the reference numbering."),
    ]))
    add(("h2", "1.3  Knowing which instance you are on"))
    add(("callout", "control", "Check before every configuration session",
         "Configuration changes are not reversible in the ordinary way: a posted journal entry "
         "is corrected by a reversal, never by an edit, and a provider that has traded cannot "
         "have its money model changed. Before each session confirm the organisation name in the "
         "top bar, the business day, and that **Finance ▸ Capital** shows the position you "
         "expect."))

    # =======================================================================
    # CHAPTER 2
    # =======================================================================
    F.chapter_is(2); T.chapter_is(2)
    add(("chapter", 2, "Organisation registration",
         "The organisation's own identity, and the settings that govern how it lends and how it "
         "numbers things."))

    add(("figures2", D("16-Administration", "settings", "owner"),
         M("16-Administration", "settings", "owner"),
         F.next("Company settings (desktop and mobile)")))

    add(("h2", "2.1  The organisation's details"))
    add(("table", ["Field", "What it is", "Where it shows up"],
         [
             ["Company name", "The trading name", "The top bar, and every screen header"],
             ["Legal name", "The registered name", "Receipts and formal documents"],
             ["Registration number", "The business registration", "Receipts"],
             ["Phone, email", "The organisation's contact details", "Receipts"],
             ["Address, city", "Where the business is", "Receipts"],
             ["Receipt header / footer", "The two lines printed on every receipt",
              "Payment and deposit receipts"],
         ],
         T.next("Company settings fields.")))
    add(("p",
         f"The demonstration organisation this manual was built on is **{ORG}**, registered at "
         f"Plot 27, Kampala Road, Kampala. Every name, number and amount in it is invented."))

    add(("h2", "2.2  Lending rules, guarantor rules and finance settings"))
    add(("figures2", D("16-Administration", "settings-lending", "owner"),
         D("16-Administration", "settings-finance", "owner"),
         F.next("Lending rules and finance settings (desktop)")))
    add(("table", ["Section", "What it governs"],
         [
             ["Lending rules", "The grace period, the penalty, the arrears thresholds and the "
              "repayment cadences the business offers"],
             ["Guarantor rules", "How many guarantors a loan needs, and the **concentration "
              "ceiling** — the most one person may stand behind across all loans"],
             ["Finance settings", "Whether cash and agency float may go negative (they should "
              "not), and the accounts the automatic postings use"],
             ["Reference numbers", "The prefixes and padding for client, loan, payment, "
              "membership, savings, claim, meeting, deposit and capital numbers"],
         ],
         T.next("The four settings sections, and what each decides.")))
    add(("callout", "warning", "Set the negative-balance rules before trading",
         "`allow_negative_cash` and `allow_negative_agency_float` decide whether POLYTOS will let "
         "a till pay out money it does not hold. For a cash business both should be off. Turning "
         "them on removes the single most useful control the system has."))
    add(("figure", D("16-Administration", "settings-references", "owner"),
         F.next("Reference numbering (desktop)"),
         "Changing a prefix after numbers have been issued does not renumber what exists. Decide "
         "these before go-live."))

    # =======================================================================
    # CHAPTER 3
    # =======================================================================
    F.chapter_is(3); T.chapter_is(3)
    add(("chapter", 3, "Branch setup",
         "Branches, the five money accounts each one owns, and the limitation you need to know "
         "about before you plan a rollout."))

    add(("figure", D("16-Administration", "settings-branches", "owner"),
         F.next("The branch panel in company settings (desktop)"),
         "Each branch with its code, location, district and opening date. Note the line beneath "
         "the list: *Read-only here.*"))

    add(("callout", "warning", "Branch registration has no screen in this release",
         "`branches:create` and `branches:update` exist in the permission matrix and are granted "
         "to the Owner / Administrator, but **no screen and no action calls them**. The same is "
         "true of `finance:accounts`, which would create a branch's ledger accounts. Opening a "
         "branch is therefore an implementation-team task in this release, not something an "
         "administrator can do alone. This is recorded as finding **F-01**."))

    add(("h2", "3.1  What a branch owns"))
    add(("p",
         "A branch is not just a name on a report. It owns five ledger accounts, and cash cannot "
         "exist outside one of them."))
    add(("table", ["Code", "Account", "Kind", "What it holds"],
         [["`1010-<BRANCH>`", "Cash at Hand", "`cash_at_hand`", "Physical money in the till"],
          ["`1020-<BRANCH>`", "MTN Mobile Money", "`mtn_mobile_money`",
           "The business's own MTN wallet — not an agency float"],
          ["`1030-<BRANCH>`", "Airtel Money", "`airtel_money`", "The business's own Airtel wallet"],
          ["`1040-<BRANCH>`", "Cash at Bank", "`bank`", "The branch's bank account"],
          ["`1050-<BRANCH>`", "Cash in Transit", "`in_transit`",
           "Cash banked and not yet confirmed"]],
         T.next("The five accounts every branch owns. The database permits exactly one cash at "
                "hand, one MTN wallet, one Airtel wallet and one transit account per branch.")))
    add(("p",
         "Agency float accounts are **not** in this list. They are created when an agent line is "
         "registered, and are numbered `1320.<PROVIDER>.<BRANCH>.<TILL>` — see Chapter 7."))

    add(("h2", "3.2  The demonstration organisation's branches"))
    add(("table", ["Code", "Branch", "Location", "District", "Opened"],
         [[f"`{c}`", n, l, d, o] for c, n, l, d, o in BRANCHES],
         T.next("The three branches this manual works through. Mbarara is the one configured "
                "from zero in the chapters that follow.")))

    # =======================================================================
    # CHAPTER 4
    # =======================================================================
    F.chapter_is(4); T.chapter_is(4)
    add(("chapter", 4, "Users, roles and separation of duties",
         "Registering staff, granting roles, and the two-person controls that will govern "
         "everything you do afterwards."))

    add(("h2", "4.1  Register the second Owner first"))
    add(("callout", "control", "Do this before anything financial",
         "POLYTOS refuses to let one person stand on both sides of a control. With a single "
         "Owner account: capital cannot be verified and therefore cannot post; no provider's "
         "terms can be approved; no provider can be brought live. The second Owner is not an "
         "optional extra — it is a prerequisite."))
    add(("figures2", W("01-users-new-empty"), W("02-users-new-filled"),
         F.next("The new user form, empty and completed (desktop)"),
         "Full name, telephone number, email address, role and a temporary password. The "
         "telephone number is the sign-in identifier and must be unique."))
    add(("steps", [
        ("Open **Administration ▸ Users ▸ New**.",
         "Desktop: Administration in the rail. Mobile: menu ▸ Administration ▸ Users."),
        ("Enter the full name, telephone number and email address.", ""),
        ("Choose the role.",
         "You may not grant a role higher than your own. An Owner may grant any of the four."),
        ("Set a temporary password and give it to the person out of band.",
         "Never by the same channel you send anything else sensitive."),
        ("Press **Create**.",
         "The account is created with *must change password* set."),
    ]))
    add(("figure", W("03-users-new-result"),
         F.next("The account created (desktop)")))
    add(("figures2", W("04-users-directory"), WM("04-users-directory"),
         F.next("The user directory (desktop and mobile)"),
         "Everybody, their roles and their status. This is also where a role is granted or "
         "removed, an account is suspended or restored, and a temporary password is issued."))

    add(("h2", "4.2  The first sign-in is forced to change the password"))
    add(("figures2", W("05-forced-password-change"), W("06-password-changed"),
         F.next("The forced password change, and the account afterwards (desktop)"),
         "A person with a temporary password reaches nothing else until they have changed it. "
         "This is enforced in the application and backed by the database, so it cannot be "
         "skipped by going straight to a URL."))

    add(("h2", "4.3  The role / permission matrix"))
    add(("table", ["Role", "Key", "Rank", "Capabilities", "What it is for"],
         [[r[0], f"`{r[1]}`", str(r[2]), {"Client": "3", "Secretary / Treasurer": "54",
                                           "Manager": "96", "Owner / Administrator": "129"}[r[0]],
           r[4]] for r in ROLE_SUMMARY],
         T.next("The four roles. The complete capability-by-capability matrix is published as "
                "`05-Verification/ROLE_PERMISSION_MATRIX.md`.")))
    add(("p",
         "Ranks are used for two narrow things: ordering roles in the interface, and the rule "
         "that an administrator may not grant a role outranking their own. Permissions are "
         "**not** derived from rank — each role's grants are listed by hand, so a capability "
         "added later belongs to nobody until somebody grants it."))

    add(("h2", "4.4  Segregation of duties, as the database enforces it"))
    add(("table", ["Control", "Recorded by", "Approved by", "Enforced as"],
         [
             ["Capital introduced", "Manager or Owner", "A different Owner",
              "`capital_fundings_verifier_not_recorder`"],
             ["Agency transaction", "Any staff", "A different Manager or Owner",
              "`agency:verify`, verifier ≠ submitter"],
             ["High-value agency transaction", "Any staff",
              "A different Manager or Owner with `agency:verify_high_value`",
              "The service's approval threshold"],
             ["Provider terms", "Whoever registered the provider", "A different Owner",
              "SQLSTATE `SD001`"],
             ["Provider go-live", "Whoever registered it", "A different Owner", "SQLSTATE `SD001`"],
             ["Bank deposit clearance", "Whoever banked it", "A different Manager or Owner",
              "`verify_bank_deposit`"],
             ["Cash reconciliation", "Whoever counted", "A different Manager or Owner",
              "`reconciliation:approve`"],
             ["Transfer", "Manager or Owner", "A different Manager or Owner", "`transfers:approve`"],
             ["Expense", "Any staff", "Manager or Owner", "`expenses:approve`"],
             ["Loan", "Secretary / Treasurer", "Manager approves, Owner disburses",
              "Two separate capabilities"],
         ],
         T.next("Every two-person control, and where it lives. These are database constraints "
                "and function guards, not screen behaviour — no route into the data can skip "
                "them, including a service-role key.")))

    add(("h2", "4.5  Changing and removing access"))
    add(("steps", [
        ("Grant another role.", "Open the person in **Users** and use *Grant another role*. "
                                "Roles are additive."),
        ("Remove a role.", "The same panel. Removing the last role leaves an account that can "
                           "sign in and do nothing."),
        ("Suspend an account.", "Set the status to suspended. They cannot sign in; their history "
                                "stays."),
        ("Issue a new password.", "*Reset password* issues a temporary one and forces a change "
                                  "at next sign-in."),
        ("Verify what somebody can actually do.",
         "Sign in as them on a test account, or read the matrix in "
         "`05-Verification/ROLE_PERMISSION_MATRIX.md`."),
    ]))
    add(("callout", "warning", "Deactivate; do not delete",
         "There is no delete. Every financial posting carries the name of whoever made it, and "
         "removing the person would break the trail. Suspending the account stops the access and "
         "keeps the history."))

    # =======================================================================
    # CHAPTER 5
    # =======================================================================
    F.chapter_is(5); T.chapter_is(5)
    add(("chapter", 5, "Registering the initial capital",
         "The single most consequential entry the business will make, the control around it, the "
         "defect that currently blocks part of it, and how the money is then allocated."))

    add(("lead",
         "This chapter is worked end to end on the demonstration organisation's **Mbarara "
         "Branch**, whose five money accounts all began at zero. Every figure below was read "
         "back out of the running system after the entry posted."))

    add(("h2", "5.1  Equity or borrowing — decide before you type"))
    add(("table", ["", "Equity: the owner's own money", "Borrowing: somebody else's"],
         [
             ["Repayable", "No", "Yes"],
             ["Interest", "No", "Possibly"],
             ["Credits", "`3000` Owner Capital", "`2310` / `2320` / `2330`"],
             ["Net worth", "Rises by the whole amount", "Unchanged"],
             ["Extra fields", "None", "Interest rate, repayable-by date"],
         ],
         T.next("The distinction the Capital screen is built around.")))
    add(("callout", "money", "Why it matters so much",
         "Before this screen existed, a lender who advanced UGX 20,000,000 was indistinguishable "
         "from an owner who contributed it. One of those leaves the business owing 20,000,000 "
         "and the other does not."))

    add(("h2", "5.2  The screen"))
    add(("figures2", W("07-capital-empty"), WM("07-capital-empty"),
         F.next("Capital introduced, before anything has been recorded (desktop and mobile)"),
         "*Owner's capital*, *Borrowed* and *Introduced in total* all read zero, and the register "
         "says so in words. The note under the form is the whole control in one line: "
         "**recording posts nothing.**"))
    add(("table", ["Field", "What to enter", "Notes"],
         [
             ["What kind of money is this", "Equity or borrowing", "Decides which account is credited"],
             ["Amount", "Whole shillings", "No cents; `20000000` or `20,000,000`"],
             ["Contributed by / Lent by", "The person or institution", "Required — capital from "
              "nobody is evidence of nothing"],
             ["The money landed in", "A cash-at-hand or bank account",
              "**Only those two kinds are offered.** Capital cannot be introduced straight into "
              "a float — see §5.5"],
             ["Credited to equity", "`3000` for equity; a `2300` account for borrowing", ""],
             ["Evidence date", "The date on the slip", "May be in the past; the journal entry is "
              "dated the day it is verified"],
             ["Evidence", "Bank transfer, cash deposit, cheque, mobile money or other", ""],
             ["Evidence reference", "The number on the slip", "This is what the second Owner "
              "checks against"],
             ["Interest rate / Repayable by", "Borrowing only", "Refused on an equity contribution"],
         ],
         T.next("The capital form, field by field.")))
    add(("figure", W("08-capital-filled"),
         F.next("UGX 20,000,000 of owner's capital entered against Cash at Hand — Mbarara"),
         "Equity, UGX 20,000,000, landing in `1010-BR2602`, credited to `3000`, evidenced by a "
         "Centenary transfer advice."))

    add(("h2", "5.3  A defect you will meet, and what to do about it"))
    add(("figure", W("09-capital-ui-refusal"),
         F.next("The same entry, refused"),
         "*Please check the highlighted fields* — and nothing is highlighted."))
    add(("callout", "warning", "Finding F-04 — equity cannot be recorded on this screen",
         "The action builds its input with `null` for the two borrowing-only fields the equity "
         "form does not display, while the rule that enforces 'equity has no terms' tests for "
         "`undefined`. Every equity contribution is therefore rejected, and the error is "
         "attached to a field that is not on screen, so nothing is highlighted and the person "
         "has no way to find out what is wrong. A **borrowing** records normally.\n\n"
         "Until it is fixed: record the contribution through the same database function the "
         "screen calls, `record_capital_funding(...)`, as the signed-in Owner. The document it "
         "writes is identical, the verification step below is unaffected, and the journal entry "
         "is the same one the screen would have produced. That is what was done for this "
         "manual, and it is recorded as `done-without-screen` in the walk-through log."))

    add(("h2", "5.4  Verification is what posts it"))
    add(("figures2", W("10-capital-awaiting-check"), WM("10-capital-awaiting-check"),
         F.next("The contribution awaiting a check, seen by the second Owner (desktop and mobile)"),
         "It appears in the register with its number and its status. *Owner's capital* still "
         "reads zero, because nothing has posted."))
    add(("figure", W("11-capital-verify-filled"),
         F.next("The second Owner records what they checked"),
         "The note is not a formality: it is the record of which document was sighted."))
    add(("figure", W("12-capital-verified"),
         F.next("Verified — and now posted"),
         "The status becomes *verified*, the journal entry is written, and *Owner's capital* "
         "shows UGX 20,000,000."))
    add(("h4", "The journal entry verification writes"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash at Hand — Mbarara", "`1010-BR2602`", "20,000,000", ""],
          ["Owner Capital", "`3000`", "", "20,000,000"],
          ["**Total**", "", "**20,000,000**", "**20,000,000**"]],
         T.next("The capital introduction, as posted. Assets rise by 20,000,000; equity rises by "
                "20,000,000; the accounting identity holds.")))
    add(("code",
         "Assets        =  Liabilities  +  Equity\n"
         "+20,000,000   =       0       +  +20,000,000"))

    add(("h2", "5.5  Allocating the capital — and the rule that matters most"))
    add(("callout", "money", "These are allocations, not further contributions",
         "The four movements below take the **same** UGX 20,000,000 and put it where the branch "
         "needs it. Not one of them touches `3000`. Recording any of them on the Capital screen "
         "would credit equity a second time and overstate the owner's stake by that amount."))
    add(("table", ["Step", "Movement", "Amount", "What it does to the books"],
         [
             ["1", "Capital introduced", "20,000,000",
              "Dr `1010-BR2602` / Cr `3000` — **the only entry that credits equity**"],
             ["2", "Bank part of the cash", "5,000,000",
              "Dr `1050-BR2602` / Cr `1010-BR2602`, then on clearance Dr `1040-BR2602` / "
              "Cr `1050-BR2602`"],
             ["3", "Buy MTN float", "3,000,000",
              "Dr `1320.MTN_MOMO.BR2602.T1` / Cr `1010-BR2602`"],
             ["4", "Buy Airtel float", "2,000,000",
              "Dr `1320.AIRTEL_MONEY.BR2602.T1` / Cr `1010-BR2602`"],
             ["5", "Buy bank agent float", "2,000,000",
              "Dr `1320.STANBIC.BR2602.T1` / Cr `1010-BR2602`"],
         ],
         T.next("The allocation, in the order it must be done. Steps 2 to 5 move one asset into "
                "another asset; equity does not change.")))
    add(("h4", "The branch's position when it is done"))
    add(("table", ["Account", "Code", "Balance"],
         [["Cash at Hand — Mbarara", "`1010-BR2602`", ugx(8_000_000)],
          ["Cash at Bank — Mbarara", "`1040-BR2602`", ugx(5_000_000)],
          ["MTN float — mbarara-mtn-1", "`1320.MTN_MOMO.BR2602.T1`", ugx(3_000_000)],
          ["Airtel float — mbarara-airtel-1", "`1320.AIRTEL_MONEY.BR2602.T1`", ugx(2_000_000)],
          ["Stanbic agent float — mbarara-stanbic-1", "`1320.STANBIC.BR2602.T1`", ugx(2_000_000)],
          ["**Total assets funded**", "", f"**{ugx(20_000_000)}**"]],
         T.next("The allocation of one UGX 20,000,000 contribution, read back out of the running "
                "system. It equals the contribution exactly, and equity was credited once.")))
    add(("figure", O("24-cash-position"),
         F.next("The resulting cash position (desktop)"),
         "Mbarara's five accounts, holding between them exactly what was introduced."))

    add(("h2", "5.6  Correcting a mistake"))
    add(("steps", [
        ("While it is still *submitted*", "Reject it. Nothing has posted, so nothing has to be "
                                          "unwound. The rejection carries a reason."),
        ("After it has been verified", "An Owner who is **not** the person who verified it "
                                       "reverses it. A contra entry is posted; the original "
                                       "stays on the record."),
        ("Never", "Edit the journal. Journal entries are append-only, and POLYTOS offers no way "
                  "to change one."),
    ]))

    # =======================================================================
    # CHAPTER 6
    # =======================================================================
    F.chapter_is(6); T.chapter_is(6)
    add(("chapter", 6, "Cash and bank accounts",
         "The money accounts a branch owns, how cash reaches the bank, and what POLYTOS does "
         "about cash that does not arrive."))

    add(("h2", "6.1  What exists, and what you can create"))
    add(("callout", "warning", "There is no screen that creates a ledger account",
         "`finance:accounts` is granted to the Owner / Administrator and nothing calls it. The "
         "chart of accounts, including each branch's five money accounts, comes from the "
         "migrations. Adding a second bank account for a branch, or provisioning a new branch's "
         "accounts, is an implementation-team task. Finding **F-01**."))

    add(("h2", "6.2  Banking cash, end to end"))
    add(("figures2", O("02-bank-deposit-before"), O("03-bank-deposit-filled"),
         F.next("The bank deposit register, and UGX 5,000,000 being banked (desktop)")))
    add(("h4", "Stage one — the cash leaves the till"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash in Transit — Mbarara", "`1050-BR2602`", "5,000,000", ""],
          ["Cash at Hand — Mbarara", "`1010-BR2602`", "", "5,000,000"]],
         T.next("Recording a bank deposit. The money is out of the till and not yet at the bank, "
                "so it sits in transit where nobody can spend it.")))
    add(("figures2", O("05-bank-deposit-awaiting"), O("06-bank-deposit-verify-filled"),
         F.next("The deposit awaiting confirmation, and the confirmation being entered (desktop)"),
         "Clearing it needs the **bank's own reference** and the **value date**. The value date "
         "may not precede the day the cash left the till, and may not be in the future."))
    add(("h4", "Stage two — the bank confirms it"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash at Bank — Mbarara", "`1040-BR2602`", "5,000,000", ""],
          ["Cash in Transit — Mbarara", "`1050-BR2602`", "", "5,000,000"]],
         T.next("Clearance. Only now does the bank balance move.")))
    add(("figure", O("07-bank-deposit-cleared"),
         F.next("The deposit cleared (desktop)")))
    add(("h2", "6.3  When the cash does not arrive"))
    add(("steps", [
        ("Open an investigation on the deposit.",
         "Its status becomes *under investigation*. The money stays in transit, spendable by "
         "nobody."),
        ("If the notes come back, confirm the physical return.",
         "Dr `1010-BR…` / Cr `1050-BR…` — the cash is back in the till, and the record says what "
         "happened."),
        ("If it is neither cleared nor returned, it stays under investigation.",
         "Deliberately. POLYTOS will not invent an accounting treatment for money nobody can "
         "account for."),
    ]))
    add(("callout", "control", "The person who banked it cannot clear it",
         "Clearance is the assertion that the money arrived. Letting the carrier assert that "
         "would remove the only check there is on cash leaving the branch."))

    # =======================================================================
    # CHAPTER 7
    # =======================================================================
    F.chapter_is(7); T.chapter_is(7)
    add(("chapter", 7, "Registering an MTN Mobile Money line",
         "The full sequence from a provider that cannot be traded to a counter that can take a "
         "customer's money — performed, not described."))

    add(("lead",
         "Bringing a mobile money partner live takes six steps and **two different Owner / "
         "Administrator accounts**. POLYTOS refuses several of the steps if the same person "
         "attempts the one before it. That is the control, and this chapter works through it in "
         "the order the system demands."))

    add(("h2", "7.1  The six steps, and who may take each"))
    add(("table", ["#", "Step", "Capability", "Who", "Screen"],
         [
             ["1", "Register the provider, or find it already in the catalogue",
              "`agency:providers`", "Owner A", "Agency ▸ Register a bank"],
             ["2", "Record the commission terms", "`agency:providers`", "Owner A",
              "**No screen** for a catalogue provider — finding F-05"],
             ["3", "Approve the terms against the signed agreement",
              "`agency:provider_approval`", "**Owner B**", "Agency ▸ Register a bank"],
             ["4", "Approve the float facility", "`agency:provider_approval`", "Owner B",
              "Agency ▸ Register a bank"],
             ["5", "Set a ceiling on at least one service", "`agency:providers`", "Owner A",
              "Agency ▸ Register an agent account"],
             ["6", "Register the agent line, then authorise go-live",
              "`agency:providers`, then `agency:provider_approval`", "Owner A, then Owner B",
              "Agency ▸ Register an agent account"],
         ],
         T.next("Bringing a provider live. Steps 3, 4 and 6 refuse the person who performed the "
                "step before.")))
    add(("figures2", W("13-providers-before"), WM("13-providers-before"),
         F.next("The providers screen before MTN is brought live (desktop and mobile)"),
         "MTN Mobile Money is listed as **provisional** with *no terms recorded*. A provisional "
         "provider can have nothing posted against it — the readiness guard refuses any state "
         "beyond draft."))

    add(("h2", "7.2  Step 1 — the provider"))
    add(("p",
         "MTN Mobile Money is already in the catalogue POLYTOS ships, as code `MTN_MOMO`, "
         "category `mobile_money`, money model **electronic float**, commission model "
         "**deferred**. If your partner is not in the catalogue, register it on this screen:"))
    add(("figure", W("14-provider-register-filled"),
         F.next("Registering a provider (desktop)"),
         "Short code, name, category, where the money sits, when commission is recognised, how "
         "it is computed, the rate, and the agreement reference."))
    add(("callout", "warning", "Finding F-09 — the Rate box rejects every value",
         "The **Rate** field is read as text and validated as a number, with no conversion "
         "between them. `0.90`, `0.9` and `90` are all rejected, and the form reports *Please "
         "check the highlighted fields*. Only an empty Rate is accepted. Until this is fixed, a "
         "provider registered on this screen must be set to **read its commission off the "
         "partner's own statement** rather than from a rate recorded here."))

    add(("h2", "7.3  Step 2 — the commission terms"))
    add(("callout", "warning", "Finding F-05 — no screen adds terms to an existing provider",
         "The registration panel captures the commission terms, and there is no other panel that "
         "can change them afterwards. A provider that is already in the catalogue — MTN, Airtel, "
         "Stanbic and the rest — arrives with no terms recorded and cannot be given any through "
         "the application. For this manual they were recorded through "
         "`revise_agency_provider_terms(...)`, which is what such a screen would call."))
    add(("table", ["Provider", "Model", "Source", "Rate", "Agreement"],
         [["MTN Mobile Money", "Deferred", "From the terms recorded here", "1.50%",
           "`MTN-AGENT-2026-00841`"],
          ["Airtel Money", "Deferred", "From the terms recorded here", "1.20%",
           "`AIR-AGENT-2026-00219`"],
          ["Stanbic Bank Agency", "Deferred", "From the terms recorded here", "0.90%",
           "`STB-AGENT-2026-00077`"]],
         T.next("The commercial terms recorded for the demonstration organisation. The rate is "
                "the one number that decides what every future transaction earns.")))

    add(("h2", "7.4  Step 3 — a second Owner approves the terms"))
    add(("figure", W("16-terms-approve-filled"),
         F.next("Approving a provider's commercial terms (desktop, the second Owner)"),
         "The agreement reference and a note saying what was checked. POLYTOS does not hold the "
         "signed agreement, so the record has to say where it is."))
    add(("callout", "control", "Why this needs a second person",
         "The commission rate decides what every future transaction earns, the agreement lives "
         "outside POLYTOS, and nothing in the system will ever notice a mistyped rate. So a "
         "different Owner checks the number against the paper. Attempting it as the person who "
         "registered the provider is refused with *You cannot approve a provider you "
         "registered.*"))
    add(("figure", W("17-providers-after-terms"),
         F.next("The providers screen after approval (desktop)"),
         "MTN is no longer provisional. It is still not live — approving the terms and "
         "authorising the business to trade are two different judgements."))

    add(("h2", "7.5  Step 4 — the float facility"))
    add(("figure", W("18-facility-filled"),
         F.next("Approving a float facility (desktop)"),
         "The facility is the limit the partner has agreed to advance, and the instrument it was "
         "granted under. A provider on the electronic-float model cannot go live without one."))
    add(("table", ["Provider", "Facility", "Granted under"],
         [["MTN Mobile Money", ugx(6_000_000), "`MTN-FAC-2026-0044`"],
          ["Airtel Money", ugx(4_000_000), "`AIR-FAC-2026-0019`"],
          ["Stanbic Bank Agency", ugx(5_000_000), "`STB-FAC-2026-0011`"]],
         T.next("The float facilities approved for the demonstration organisation.")))

    add(("h2", "7.6  Step 5 — a ceiling on each service"))
    add(("figure", W("26-ceiling-filled"),
         F.next("Setting the largest single transaction a service may carry (desktop)"),
         "A provider cannot go live until at least one of its services carries a ceiling. The "
         "ceiling is the most the counter may put through in one transaction."))
    add(("table", ["Service", "Direction", "Ceiling"],
         [["MTN Mobile Money — MoMo Deposit", "Deposit", ugx(2_000_000)],
          ["MTN Mobile Money — MoMo Withdrawal", "Withdrawal", ugx(1_000_000)],
          ["Airtel Money — Airtel Money Deposit", "Deposit", ugx(2_000_000)],
          ["Airtel Money — Airtel Money Withdrawal", "Withdrawal", ugx(1_000_000)],
          ["Stanbic Bank Agency — Bank Agency Deposit", "Deposit", ugx(3_000_000)],
          ["Stanbic Bank Agency — Bank Agency Withdrawal", "Withdrawal", ugx(1_500_000)]],
         T.next("The service ceilings set for the demonstration organisation.")))
    add(("p",
         "Separately from the ceiling, a service may carry an **approval threshold** — an amount "
         "above which the transaction may only be verified by somebody holding "
         "`agency:verify_high_value`. Set it on the same screen, under *Set an approval "
         "threshold*."))

    add(("h2", "7.7  Step 6 — the line itself"))
    add(("figures2", W("19-lines-before"), W("20-line-mtn-filled"),
         F.next("The agent accounts screen, and an MTN line being registered (desktop)")))
    add(("table", ["Field", "What to enter", "Notes"],
         [
             ["Provider", "MTN Mobile Money", "Only registered providers are listed"],
             ["Location", "The branch", "Decides which cash account the line trades against"],
             ["Account name / Till name", "`mbarara-mtn-1`",
              "**Lower-case letters, digits, hyphens and underscores only.** The form does not "
              "say so — finding F-07"],
             ["Label", "What the staff call it, e.g. *MTN counter*", ""],
             ["Agent identifier", "The agent code the partner issued", ""],
             ["Line number", "The MSISDN, as `+256772900111`",
              "Must match `+256` and nine digits"],
             ["Opened on", "The date the line was opened", ""],
         ],
         T.next("Registering an agent line, field by field.")))
    add(("callout", "money", "What registering a line creates",
         "A float account in the ledger, numbered `1320.<PROVIDER>.<BRANCH>.<TILL>` — for this "
         "demonstration, `1320.MTN_MOMO.BR2602.T1`. That account is where the line's electronic "
         "value lives, and it starts at zero. Registering a second MTN line at the same branch "
         "creates a second, separate float account; the two are never pooled."))
    add(("figure", W("22-lines-after"),
         F.next("The agent lines after registration (desktop)")))
    add(("figure", W("25-providers-live"),
         F.next("The providers screen with MTN, Airtel and Stanbic live (desktop)"),
         "Terms approved, facility approved, a ceiling on each service, an agent account open, "
         "and authorised to trade."))
    add(("callout", "warning", "Finding F-05b — go-live has no working control on the screen",
         "The providers screen offers *Take out of service* for a live provider, but the "
         "walk-through could not drive a go-live control on it. Activation was performed through "
         "`activate_agency_provider(...)`, which is what such a control would call, by the second "
         "Owner. Everything the guard requires — approved terms, an approved facility, a service "
         "ceiling and an open agent account — had to be in place first, and the refusals that "
         "said so are quoted in the walk-through log."))

    add(("h2", "7.8  Authorise the staff who may trade the line"))
    add(("figures2", O("01-staffing-mobile-money"), OM("01-staffing-mobile-money"),
         F.next("Till authorisations (desktop and mobile)"),
         "A line can be traded only by staff authorised on it. Somebody not on this list will "
         "not see the till in the Record transaction screen at all."))
    add(("steps", [
        ("Open **Agency ▸ Mobile Money ▸ Line authorisations**.", ""),
        ("Find the line, choose the employee and record the mandate reference.", ""),
        ("Press **Authorise on this account**.", "They can now trade that till and no other."),
        ("To remove somebody, use **Withdraw** and give a reason.",
         "The authorisation is ended; the history stays."),
    ]))

    add(("h2", "7.9  Fund the float, and prove the arithmetic"))
    add(("figures2", O("08-float-replenish-before"), O("09-float-replenish-filled"),
         F.next("Float top-up, before and completed (desktop)"),
         "Choose the till, the amount, the account the money comes from, and the partner's "
         "reference for the purchase."))
    add(("h4", "Buying UGX 3,000,000 of MTN float out of cash"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["MTN float — mbarara-mtn-1", "`1320.MTN_MOMO.BR2602.T1`", "3,000,000", ""],
          ["Cash at Hand — Mbarara", "`1010-BR2602`", "", "3,000,000"]],
         T.next("A float purchase. One asset becomes another; nothing is earned and nothing is "
                "owed.")))
    add(("figure", O("10-float-replenish-done"),
         F.next("The float funded (desktop)")))

    add(("h2", "7.10  How the line then behaves"))
    add(("table", ["", "Customer deposit", "Customer withdrawal"],
         [["The customer", "Hands over UGX 200,000 cash; their wallet is credited",
           "Sends UGX 150,000 of value; takes cash"],
          ["Cash at Hand `1010-BR2602`", "**+200,000**", "**−150,000**"],
          ["MTN float `1320.MTN_MOMO.BR2602.T1`", "**−200,000**", "**+150,000**"],
          ["Commission at 1.50%", "3,000 to `1310` / `4510`", "2,250 to `1310` / `4510`"]],
         T.next("The core effect of each direction, with the commission shown separately because "
                "it is a separate entry that touches neither cash nor float.")))
    add(("figures2", O("12-D1-record-filled"), O("17-D1-posted"),
         F.next("A UGX 200,000 MTN deposit recorded, and the same transaction posted (desktop)")))
    add(("figure", O("18-float-balances"),
         F.next("Float and till balances after trading (desktop)"),
         "The figures here are the ones a counter checks before serving the next customer."))

    # =======================================================================
    # CHAPTER 8
    # =======================================================================
    F.chapter_is(8); T.chapter_is(8)
    add(("chapter", 8, "Registering an Airtel Money line",
         "The same six steps, a separate partner, and a float that is never pooled with MTN's."))

    add(("p",
         "Airtel Money is configured exactly as MTN is — the sequence in Chapter 7 applies "
         "unchanged. This chapter records what differs."))
    add(("table", ["", "MTN Mobile Money", "Airtel Money"],
         [["Code", "`MTN_MOMO`", "`AIRTEL_MONEY`"],
          ["Money model", "Electronic float", "Electronic float"],
          ["Commission model", "Deferred", "Deferred"],
          ["Agreed rate", "1.50%", "1.20%"],
          ["Agreement", "`MTN-AGENT-2026-00841`", "`AIR-AGENT-2026-00219`"],
          ["Facility", ugx(6_000_000), ugx(4_000_000)],
          ["Line at Mbarara", "`mbarara-mtn-1`", "`mbarara-airtel-1`"],
          ["Float account", "`1320.MTN_MOMO.BR2602.T1`", "`1320.AIRTEL_MONEY.BR2602.T1`"],
          ["Opening float", ugx(3_000_000), ugx(2_000_000)],
          ["Commission income account", "`4510` Mobile Money Commission", "`4510` Mobile Money Commission"]],
         T.next("MTN and Airtel side by side, as configured for the demonstration organisation.")))
    add(("callout", "money", "Separate floats, separate statements, separate reconciliation",
         "The two providers share the `4510` income account and nothing else. Each has its own "
         "float account, its own commission receivable position, its own provider statement and "
         "its own reconciliation. A shortage on one is never covered by the other, and POLYTOS "
         "will refuse an Airtel deposit for want of Airtel float however much MTN float is "
         "sitting beside it."))
    add(("figures2", O("22-money-airtel"), M("13-MobileMoney", "money-airtel", "owner"),
         F.next("The Airtel provider screen (desktop and mobile)")))
    add(("h2", "8.1  More than one line per provider"))
    add(("p",
         "Register a second line exactly as the first, with a different till name. Each line "
         "gets its own float account (`…T1`, `…T2`), its own authorised staff and its own "
         "reconciliation. This is how a branch runs two counters, or how a provider's line is "
         "replaced without disturbing the history of the old one."))

    # =======================================================================
    # CHAPTER 9
    # =======================================================================
    F.chapter_is(9); T.chapter_is(9)
    add(("chapter", 9, "Registering a bank agency account",
         "Partner banks: which the application supports, the two money models, and the one that "
         "will stop a withdrawal dead."))

    add(("h2", "9.1  Which banks are supported"))
    add(("p",
         "POLYTOS does not hard-code any bank. The catalogue it ships carries one agency banking "
         "row — **Stanbic Bank Agency** — and the registration screen creates further providers "
         "in any category, so a partner bank is a configuration matter, not a code change. The "
         "demonstration organisation brings **Stanbic Bank Agency** live, and the attempt to "
         "register a brand-new bank is recorded in §9.5 along with the defect that stopped it."))
    add(("table", ["Provider", "Code", "Category", "In the shipped catalogue?"],
         [["Stanbic Bank Agency", "`STANBIC`", "`agency_banking`", "Yes"],
          ["School Fees Collection", "`SCHOOL_FEES`", "`school_fees`", "Yes"],
          ["MTN Mobile Money", "`MTN_MOMO`", "`mobile_money`", "Yes"],
          ["Airtel Money", "`AIRTEL_MONEY`", "`mobile_money`", "Yes"],
          ["UEDCL Yaka Electricity", "`UEDCL`", "`utility`", "Yes"],
          ["NWSC Water", "`NWSC`", "`utility`", "Yes"],
          ["DStv / GOtv", "`DSTV` / `GOTV`", "`tv_subscription`", "Yes"],
          ["Lycamobile Airtime & Data", "`LYCAMOBILE`", "`airtime_data`", "Yes"],
          ["Any other partner", "—", "Any of the above categories", "Register it yourself"]],
         T.next("The provider catalogue POLYTOS ships. Every row arrives **provisional and "
                "inactive** — none of them can be traded until an administrator does the work in "
                "Chapter 7.")))

    add(("h2", "9.2  The two money models — decide this first"))
    add(("table", ["", "Electronic float", "Cash, payable to the provider"],
         [["What the agent holds", "Float the bank has advanced", "The customer's cash, owed onward"],
          ["Account", "`1320…` (asset)", "`2220` Bank Agency Payable (liability)"],
          ["Deposit", "Dr cash / Cr float", "Dr cash / Cr payable"],
          ["Withdrawal", "Dr float / Cr cash", "Dr payable / Cr cash"],
          ["What limits a withdrawal", "The float held", "**Only what that bank's deposits have "
           "collected**"],
          ["Pre-funding possible?", "Yes — buy float", "No"],
          ["Settlement", "Buy more float", "Hand the cash to the bank"]],
         T.next("The two money models for a partner bank.")))
    add(("callout", "warning", "Under the cash-payable model there is no working float",
         "POLYTOS computes what is held on each bank's behalf before paying out and refuses any "
         "withdrawal larger than that. A negative liability is not a liability — it is the "
         "business having advanced its own cash on the bank's behalf, which is a receivable "
         "nobody has agreed to. There is no flag, no override and no capability that relaxes it. "
         "An advance arrangement is specified in the project documents and is deliberately **not "
         "implemented**.\n\n"
         "If you want a bank counter that can pay out from a pre-funded balance — which is what "
         "'agent banking working float' usually means — the bank must be on the **electronic "
         "float** model."))
    add(("figure", D("14-AgencySetup", "agency-providers", "owner"),
         F.next("Correcting a provisional provider's money model (desktop)"),
         "The *Correct a provisional provider's money model* panel moves a provider between the "
         "two models. It is permitted **only while the provider is still provisional**, because "
         "a provider that has traded would leave a real liability behind with no path to settle "
         "it under the new model. Stanbic ships as cash-payable; the demonstration organisation "
         "moved it to electronic float before approving its terms."))

    add(("h2", "9.3  Registering the agent account"))
    add(("figure", W("21-line-bank-filled"),
         F.next("Registering a bank agent account (desktop)"),
         "The same panel as a mobile money line, with one extra field: **the partner's account "
         "number**, which is the settlement account the bank holds for the agent."))
    add(("table", ["Field", "For the demonstration organisation"],
         [["Provider", "Stanbic Bank Agency"],
          ["Location", "BR2602 — Mbarara Branch"],
          ["Account name", "`mbarara-stanbic-1`"],
          ["Label", "Bank agency counter"],
          ["Agent identifier", "`STBAG-004417`"],
          ["The partner's account number", "`9030000417`"],
          ["Line number", "`+256772900102` — see the note below"],
          ["Float account created", "`1320.STANBIC.BR2602.T1`"],
          ["Opening float", ugx(2_000_000)]],
         T.next("The bank agent account registered for this manual.")))
    add(("callout", "warning", "Finding F-08 — a bank agent account still needs a mobile number",
         "The **Line number** field is validated as a Ugandan mobile number and does not accept "
         "an empty value, because the form always submits one. A bank agency counter has no "
         "mobile line, so registering one is refused until some number is entered. For this "
         "manual the branch's own telephone number was used. Until it is fixed, enter the "
         "branch's number and record in the notes that it is not a provider line."))
    add(("figure", W("23-banking-accounts"),
         F.next("The register of banks and agent accounts (desktop)")))

    add(("h2", "9.4  Trading on it"))
    add(("figures2", O("11-A1-record-before"), O("12-A1-record-filled"),
         F.next("A UGX 400,000 bank agency deposit being recorded (desktop)"),
         "The customer identifier is their **bank account number**; the provider reference is "
         "the bank's own confirmation."))
    add(("h4", "A UGX 400,000 deposit, on the electronic float model"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash at Hand — Mbarara", "`1010-BR2602`", "400,000", ""],
          ["Stanbic agent float", "`1320.STANBIC.BR2602.T1`", "", "400,000"]],
         T.next("A bank agency deposit.")))
    add(("h4", "The commission on it, at the agreed 0.90%"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Agency Commission Receivable", "`1310`", "3,600", ""],
          ["Agency Banking Commission", "`4520`", "", "3,600"]],
         T.next("Bank agency commission credits `4520`, not `4510`. That is how the commission "
                "reports separate mobile money from bank agency.")))
    add(("h4", "A withdrawal of UGX 150,000"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Stanbic agent float", "`1320.STANBIC.BR2602.T1`", "150,000", ""],
          ["Cash at Hand — Mbarara", "`1010-BR2602`", "", "150,000"]],
         T.next("A bank agency withdrawal, on the electronic float model. If the branch cannot "
                "cover the cash, POLYTOS refuses it before anything posts.")))
    add(("figure", O("23-banking-overview"),
         F.next("The agent banking overview (desktop)")))

    add(("h2", "9.5  Registering a bank that is not in the catalogue"))
    add(("p",
         "The walk-through attempted to register **Centenary Bank Agency** from scratch, with a "
         "0.90% rate agreed in a signed schedule. It could not be completed:"))
    add(("figure", W("15-provider-rate-refused"),
         F.next("A brand-new bank registration, refused (desktop)"),
         "*Please check the highlighted fields.* The Rate box is the cause — see finding F-09 in "
         "§7.2. A provider registered with the Rate box left empty, reading its commission off "
         "the partner's statement, is accepted."))

    add(("h2", "9.6  Float purchase, transfer and settlement"))
    add(("table", ["Operation", "Where", "Who", "What it does"],
         [["Buy float", "Agency ▸ Float top-ups", "`agency:settlements`",
           "Dr the float / Cr cash or bank"],
          ["Move float between tills", "Agency ▸ Account transfers", "`agency:float_trade`",
           "Dr one float / Cr another"],
          ["Receive commission", "Agency ▸ Commissions", "`agency:settlements`",
           "Dr float or bank / Cr `1310` — **not** income"],
          ["Hand over held cash", "Agency ▸ Settlements", "`agency:settlements`",
           "Dr the payable / Cr cash"]],
         T.next("The four money movements on an agency account, and what each posts.")))

    # =======================================================================
    # CHAPTER 10
    # =======================================================================
    F.chapter_is(10); T.chapter_is(10)
    add(("chapter", 10, "Commissions and monthly settlement",
         "Configuring what you earn, recognising it, and collecting it without counting it twice."))

    add(("h2", "10.1  The configuration"))
    add(("table", ["Setting", "Values", "Where"],
         [["Commission model", "Deferred (the partner remits later) or immediate (taken in the "
           "transaction)", "Provider registration / terms"],
          ["Commission source", "From the terms recorded here, or read off the partner's own "
           "statement", "Provider registration / terms"],
          ["Rate or flat amount", "Basis points, or a fixed amount per transaction",
           "Provider registration / terms"],
          ["Income account", "Chosen from the `4500` series by the provider's category",
           "Automatic"]],
         T.next("The commission settings on a provider.")))
    add(("table", ["Category", "Income account"],
         [["Mobile money", "`4510` Mobile Money Commission"],
          ["Agency banking", "`4520` Agency Banking Commission"],
          ["Utility", "`4530` Utility Commission"],
          ["School fees", "`4540` School Fees Commission"],
          ["TV subscription", "`4550` TV Subscription Commission"],
          ["Airtime and data", "`4560` Airtime & Data Commission"],
          ["Service fees", "`4570` Agency Service Fees"],
          ["Anything else", "`4590` Other Agency Commission"]],
         T.next("Which income account a provider's commission credits. The mapping follows the "
                "category, so it cannot be set wrongly by hand.")))

    add(("h2", "10.2  The lifecycle"))
    add(("steps", [
        ("A transaction posts.",
         "Dr `1310` Agency Commission Receivable / Cr the category's income account. **The "
         "income is recognised here.**"),
        ("The commission accumulates as a receivable.",
         "Visible on Agency ▸ Commissions and on each provider's own screen. It is an asset, not "
         "cash, and cannot be spent."),
        ("The provider sends a statement.",
         "Compare it with the system figure on the commission reconciliation screen."),
        ("The provider remits.",
         "Dr the float or the bank / Cr `1310`. **No income account is touched.**"),
        ("Reconcile and certify.",
         "Any difference is investigated; an unexplained remainder is written off by an Owner."),
    ]))
    add(("figures2", O("19-commission"), D("13-MobileMoney", "money-mtn-commission", "owner"),
         F.next("The commission screen and one provider's position (desktop)")))
    add(("callout", "money", "The error that doubles a month's income",
         "If a settlement credited the income account again, every shilling of commission would "
         "be counted twice — once when it was earned and once when it was paid. POLYTOS does not "
         "do this, and no manual reconciliation beside it should. **Commission income for a "
         "month is what was earned in that month, not what was received.**"))

    add(("h2", "10.3  Corrections"))
    add(("table", ["Situation", "Control", "Who"],
         [["The computed commission does not match what the partner actually paid",
           "A commission exception, with a reason and evidence", "`agency:commission_exception` "
           "— Owner only"],
          ["A settlement was recorded wrongly", "Reverse the settlement",
           "`agency:settlements`, and not the person who recorded it"],
          ["The partner clawed commission back", "A commission recovery", "`agency:settlements`"],
          ["The statement and the system disagree and nobody can explain it",
           "Write it off after the reconciliation is certified", "Owner only"]],
         T.next("Correcting commission, and who may do each thing.")))

    # =======================================================================
    # CHAPTER 11
    # =======================================================================
    F.chapter_is(11); T.chapter_is(11)
    add(("chapter", 11, "Reconciliation setup and routine",
         "What has to be reconciled, how often, against what, and who signs it off."))

    add(("table", ["Reconciliation", "Against", "How often", "Performed by", "Approved by"],
         [["Branch cash", "A physical count", "Daily, at close",
           "Anyone with `reconciliation:perform`", "A different Manager or Owner"],
          ["Agency till cash", "A physical count", "Daily, at close", "`agency:reconcile`",
           "A different Manager or Owner"],
          ["Agency float", "The provider's statement", "Daily or weekly", "`agency:reconcile`",
           "A different Manager or Owner"],
          ["Commission", "The provider's remittance statement", "Monthly", "`agency:reconcile`",
           "Certification"],
          ["Bank", "The bank statement", "Monthly", "`reconciliation:perform`",
           "A Manager or Owner"],
          ["Provider payables", "What the partner says is owed", "At settlement",
           "`agency:settlements`", "A Manager or Owner"]],
         T.next("Every reconciliation POLYTOS implements, and the independent source each uses.")))
    add(("figures2", O("28-reconciliation-cash"), O("29-reconciliation-float"),
         F.next("Agency cash and float reconciliation (desktop)")))
    add(("callout", "control", "A reconciliation needs a second person",
         "Migration `20261112000200` is named *reconciliation needs a second person*, and that is "
         "exactly what it enforces. The person who counted or who read the statement may not be "
         "the person who approves the result. A count you approve yourself proves nothing."))
    add(("h2", "11.1  Working a variance"))
    add(("numbers", [
        "**Check for unverified transactions first.** A transaction awaiting verification has "
        "posted nothing, so it is the commonest cause of a float or cash difference, and the "
        "difference will be exactly its amount.",
        "**Check for a mis-keyed amount** against the provider's statement line by line.",
        "**Check for a provider fee** POLYTOS has not been told about.",
        "**Check for a transaction recorded on the wrong till.**",
        "Only when none of those explains it, write the remainder off — and that needs "
        "`agency:variance_adjustment`, which only an Owner holds. It posts to `5960 Agency Float "
        "Over and Short` with the reason attached.",
    ]))
    add(("figure", D("12-Agency", "agency-exceptions", "owner"),
         F.next("End-of-day exceptions (desktop)"),
         "The list that decides whether a day can close cleanly."))

    # =======================================================================
    # CHAPTER 12
    # =======================================================================
    F.chapter_is(12); T.chapter_is(12)
    add(("chapter", 12, "Loan products, savings and membership policy",
         "The financial products that have to exist before anybody can lend or save."))

    add(("h2", "12.1  Loan products"))
    add(("figures2", D("16-Administration", "settings-products", "owner"),
         D("16-Administration", "settings-products-new", "owner"),
         F.next("The loan product list and a new product (desktop)")))
    add(("table", ["Field", "What it decides"],
         [["Name and code", "How the product is identified on an application"],
          ["Interest rate and basis", "What is charged, and per what period"],
          ["Interest method", "Reducing balance, calculated as the product says"],
          ["Repayment cadence", "Daily, every two days, every three days, weekly or monthly — "
           "whichever the business has enabled"],
          ["Minimum and maximum principal", "The band an application must fall inside"],
          ["Term limits", "The shortest and longest term"],
          ["Grace period", "How long after a due date before arrears begin"],
          ["Penalty", "What is charged on an expiry, once"],
          ["Guarantors required", "How many"],
          ["Fees", "Application, processing and documentation fees, and the income account each "
           "credits"]],
         T.next("A loan product, field by field. An application takes its terms from the "
                "product, so no lending is possible until at least one exists.")))
    add(("callout", "control", "Product terms are approved, not merely saved",
         "Changing a product's commercial terms goes through `approve_loan_product_terms`, and a "
         "change of cadence is checked against the loans already written on it. A product that "
         "has lent cannot have its arithmetic quietly changed underneath those agreements."))

    add(("h2", "12.2  Membership policy, savings and benefits"))
    add(("figures2", D("03-Membership", "membership-policies", "owner"),
         D("03-Membership", "membership-policy-transitions", "owner"),
         F.next("The membership policy, and policy version transitions (desktop)")))
    add(("table", ["Setting", "What it decides"],
         [["Registration fee", "What a member pays to join, and the income account it credits"],
          ["Savings minimum", "The monthly minimum a member is expected to save"],
          ["Member loan multiplier", "How much a member may borrow against their savings"],
          ["Interest basis and method", "How a member loan is charged"],
          ["Maximum term", "The longest a member loan may run"],
          ["Benefit annual cap", "The most a member may claim in a benefit year"],
          ["Claims per year", "How many claims a member may make"],
          ["Waiting period", "How long after joining before a claim is possible"],
          ["Year basis", "Calendar year, or a year from the member's join date"],
          ["Meeting fine", "What an unexcused absence costs"]],
         T.next("The membership policy. It is **versioned**: members accept a version, and "
                "publishing a new one is an Owner-only act that existing members must "
                "re-accept.")))
    add(("callout", "warning", "A membership policy version must be published before enrolment",
         "Enrolment ties a client, a policy version and a registration fee receipt together. "
         "Without a published version there is nothing to accept, and no member can be enrolled."))

    # =======================================================================
    # CHAPTER 13
    # =======================================================================
    F.chapter_is(13); T.chapter_is(13)
    add(("chapter", 13, "Approval, security and operational controls",
         "Everything POLYTOS will refuse to let one person do alone, and the settings that "
         "govern the rest."))

    add(("h2", "13.1  The controls, in one place"))
    add(("table", ["Control", "What it prevents", "Where it is configured"],
         [["Maker-checker", "One person both making and approving a financial entry",
           "Not configurable — it is a database constraint"],
          ["Service ceilings", "A transaction larger than the partner agreed",
           "Agency ▸ Register an agent account ▸ Set the ceiling"],
          ["Approval thresholds", "A large transaction verified by somebody too junior",
           "Agency ▸ Set an approval threshold"],
          ["Float facility", "Trading beyond what the partner agreed to advance",
           "Agency ▸ Approve a facility"],
          ["Negative balance rules", "Paying out money the business does not hold",
           "Administration ▸ Finance Settings"],
          ["Guarantor concentration ceiling", "One guarantor standing behind too much",
           "Administration ▸ Guarantor Rules"],
          ["Payable floor", "A bank agency withdrawal beyond what was collected",
           "Not configurable — absolute"],
          ["Duplicate references", "The same provider reference recorded twice",
           "Not configurable"],
          ["Idempotency keys", "A double click posting twice", "Not configurable"],
          ["Till authorisation", "Staff trading a line they are not mandated on",
           "Agency ▸ Line / Account authorisations"],
          ["Forced password change", "A temporary password staying in use",
           "Not configurable"],
          ["Rate limiting", "Repeated sign-in attempts and repeated postings",
           "Not configurable"],
          ["Append-only journals", "A posted entry being edited", "Not configurable"],
          ["Audit trail", "A change nobody can account for", "Not configurable"]],
         T.next("The operational controls, and which of them an administrator can change. Most "
                "cannot be changed, and that is deliberate.")))

    add(("h2", "13.2  Reversals — who may undo what"))
    add(("table", ["What", "Same day", "An earlier day"],
         [["Agency transaction", "Manager or Owner (`agency:reverse`)",
           "Owner only (`agency:reverse_cross_day`)"],
          ["Loan repayment", "Owner only", "Owner only"],
          ["Savings transaction", "Owner only", "Owner only"],
          ["Capital", "Owner, and not the person who verified it", "The same"],
          ["Transfer / expense / other income", "Whoever may approve it, and not the approver",
           "The same"],
          ["Bank clearance", "Manager or Owner", "The same"],
          ["Commission settlement", "`agency:settlements`, not the recorder", "The same"],
          ["Meeting fine", "Owner only", "Owner only"]],
         T.next("Reversal rights. In every case the original stays on the record and the "
                "reversal is a new, contra entry.")))

    add(("h2", "13.3  The audit trail"))
    add(("figure", O("30-audit"),
         F.next("The audit trail (desktop)"),
         "Every configuration change, approval, reversal and status change, with the person and "
         "the time. `audit:view` is held by the Owner / Administrator alone."))
    add(("callout", "note", "There is no read-only oversight role",
         "An external auditor has to be given an Owner / Administrator account, which also "
         "carries the ability to change things. If your governance requires a genuinely "
         "read-only account, that role does not exist in this release — finding **F-06**."))

    # =======================================================================
    # CHAPTER 14
    # =======================================================================
    F.chapter_is(14); T.chapter_is(14)
    add(("chapter", 14, "What an administrator should watch",
         "A daily, weekly and monthly routine, and the screen that answers each question."))

    add(("h2", "14.1  Daily"))
    add(("table", ["Check", "Screen", "What 'wrong' looks like"],
         [["Anything awaiting a decision", "Dashboard ▸ Awaiting a decision", "A queue that is growing"],
          ["Unverified counter transactions", "Agency ▸ Pending verification",
           "Anything left at the end of the day"],
          ["End-of-day exceptions", "Agency ▸ End-of-day exceptions", "Any entry at all"],
          ["Float levels", "Agency ▸ Float and till balances", "A till that cannot serve tomorrow"],
          ["Cash position", "Finance ▸ Cash Position", "Cash that does not match the count"],
          ["Cash counts approved", "Finance ▸ Reconciliation", "Yesterday's count still open"],
          ["Cash in transit", "Finance ▸ Bank Deposits", "A deposit neither cleared nor returned"]],
         T.next("The daily round.")))

    add(("h2", "14.2  Weekly"))
    add(("bullets", [
        "**Arrears and ageing** — Reports ▸ Arrears, Reports ▸ Ageing.",
        "**Collections against expectation** — Reports ▸ Collections.",
        "**Branch performance** — Branch Network ▸ Branch Performance.",
        "**Float reconciliation against each provider's statement.**",
        "**Users** — anybody who has left, any role that is wider than the job.",
    ]))

    add(("h2", "14.3  Monthly"))
    add(("bullets", [
        "**Trial balance** — Finance ▸ Trial Balance. Debits must equal credits.",
        "**Commission reconciliation and settlement**, provider by provider.",
        "**Bank reconciliation** against the bank statement.",
        "**Payables** — what is held on others' behalf, and whether it has been handed over.",
        "**Audit trail** — every configuration change in the month, and who made it.",
        "**Portfolio at risk** and the penalty position.",
    ]))
    add(("figures2", O("25-trial-balance"), O("27-agency-reports"),
         F.next("The trial balance and the agency reports (desktop)"),
         "These two screens between them answer most of what a monthly review asks."))

    # =======================================================================
    # CHAPTER 15
    # =======================================================================
    F.chapter_is(15); T.chapter_is(15)
    add(("chapter", 15, "The go-live checklist",
         "What must be true before a branch takes its first customer — and what being 'ready' "
         "does and does not mean."))

    add(("callout", "warning", "Configuration complete is not authorisation to trade",
         "This checklist says the system is configured. It is **not** a licence, an audit "
         "opinion, or a statement that the business may legally operate. Agency agreements, "
         "regulatory permissions and the decision to go live belong to the business and its "
         "advisers, not to this document."))

    add(("h2", "15.1  Organisation and branches"))
    add(("table", ["#", "Check", "Where", "Done?"],
         [["1", "Company name, legal name and registration number are correct",
           "Administration ▸ Company Settings", ""],
          ["2", "Receipt header and footer read correctly", "Administration ▸ Company Settings", ""],
          ["3", "Every branch that will trade exists with its five money accounts",
           "Administration ▸ Branch network; Finance ▸ Cash Position", ""],
          ["4", "Reference prefixes are the ones the business wants",
           "Administration ▸ Reference Numbers", ""],
          ["5", "Negative cash and negative float are **off**",
           "Administration ▸ Finance Settings", ""]],
         T.next("Organisation and branches.")))

    add(("h2", "15.2  People"))
    add(("table", ["#", "Check", "Where", "Done?"],
         [["6", "**At least two Owner / Administrator accounts exist and can sign in**",
           "Administration ▸ Users", ""],
          ["7", "Every member of staff has an account, with the narrowest role that fits",
           "Administration ▸ Users", ""],
          ["8", "No temporary password is still in use",
           "Administration ▸ Users — *must change password*", ""],
          ["9", "Nobody who has left still has access", "Administration ▸ Users", ""],
          ["10", "Counter staff are authorised on the tills they will trade",
           "Agency ▸ Line / Account authorisations", ""]],
         T.next("People and access.")))

    add(("h2", "15.3  Money"))
    add(("table", ["#", "Check", "Where", "Done?"],
         [["11", "Capital introduced is recorded **and verified**", "Finance ▸ Capital", ""],
          ["12", "Equity has been credited **once**, and the allocations do not credit it again",
           "Finance ▸ General Ledger, account `3000`", ""],
          ["13", "Cash at hand matches a physical count", "Finance ▸ Reconciliation", ""],
          ["14", "Bank balances match the bank's own statement", "Finance ▸ Cash Position", ""],
          ["15", "Nothing is sitting in Cash in Transit", "Finance ▸ Bank Deposits", ""],
          ["16", "Every till holds the float it is meant to", "Agency ▸ Float and till balances", ""],
          ["17", "**The trial balance balances**", "Finance ▸ Trial Balance", ""]],
         T.next("The financial position.")))

    add(("h2", "15.4  Agency"))
    add(("table", ["#", "Check", "Where", "Done?"],
         [["18", "Every provider that will trade is **not provisional**",
           "Agency ▸ All banks & accounts", ""],
          ["19", "Every provider's commission terms match the signed agreement",
           "Agency ▸ All banks & accounts", ""],
          ["20", "Every float-model provider has an approved facility",
           "Agency ▸ All banks & accounts", ""],
          ["21", "Every service that will be sold has a ceiling",
           "Agency ▸ Register an agent account", ""],
          ["22", "Approval thresholds are set where the business wants a second pair of eyes",
           "Agency ▸ Set an approval threshold", ""],
          ["23", "Every provider that will trade has an agent account at each trading branch",
           "Agency ▸ All banks & accounts", ""],
          ["24", "Every provider that will trade is **live**", "Agency ▸ All banks & accounts", ""],
          ["25", "A test transaction has been recorded, verified and reversed on each provider",
           "Agency ▸ Record transaction, then Transaction history", ""]],
         T.next("Agency configuration.")))

    add(("h2", "15.5  Products and reporting"))
    add(("table", ["#", "Check", "Where", "Done?"],
         [["26", "At least one loan product exists, with approved terms",
           "Administration ▸ Loan Products", ""],
          ["27", "Lending rules, grace period and penalty are set",
           "Administration ▸ Lending Rules", ""],
          ["28", "Guarantor rules and the concentration ceiling are set",
           "Administration ▸ Guarantor Rules", ""],
          ["29", "A membership policy version is published, if membership will be used",
           "Membership ▸ Membership Policy", ""],
          ["30", "Every report opens and exports", "Reports ▸ Reports Centre", ""],
          ["31", "The audit trail shows this configuration work",
           "Administration ▸ Audit Trail", ""],
          ["32", "A backup of the database has been taken and restored once, somewhere else",
           "Outside POLYTOS", ""]],
         T.next("Products, reporting and the thing everybody forgets.")))

    add(("h2", "15.6  Known defects to brief your staff on"))
    add(("table", ["Finding", "What it blocks", "What to do"],
         [["F-01", "Branch and ledger account creation have no screen",
           "Plan branch openings with whoever maintains the system"],
          ["F-02", "A member's own page fails for the Secretary / Treasurer",
           "Secretaries work from the register; Managers open the member's page"],
          ["F-04", "Recording an **equity** capital contribution is refused",
           "Have it recorded for you, or record a borrowing if that is what it is"],
          ["F-05", "No screen adds commission terms to a catalogue provider",
           "Have the terms recorded for you, or register your own provider row"],
          ["F-07", "The till name rule is not stated on the form",
           "Use lower-case letters, digits, hyphens and underscores"],
          ["F-08", "A bank agent account will not register without a mobile number",
           "Enter the branch's number and note why"],
          ["F-09", "The commission Rate box rejects every value",
           "Register the provider as reading its commission off the partner's statement"]],
         T.next("The defects this documentation project found and verified. The full report, "
                "with reproduction steps, is `06-Findings/FINDINGS_AND_GAPS.md`.")))

    add(("h2", "15.7  Glossary"))
    add(("kv", GLOSSARY))

    return B
