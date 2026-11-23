"""
POLYTOS Complete User & Operations Manual — Part C.

Finance, the agency modules, reports, oversight, and the reference matter.
"""

from content_common import D, GLOSSARY, M, Figures, Tables, ugx

F = Figures()
T = Tables()


def OPS(name):
    return D("19-Operations", name)


def OPSM(name):
    return M("19-Operations", name)


def blocks():
    B = []
    add = B.append

    # =======================================================================
    # CHAPTER 18 — FINANCE
    # =======================================================================
    F.chapter_is(18); T.chapter_is(18)
    add(("chapter", 18, "Finance",
         "Where the business's own money is, how it moves between accounts, and the books that "
         "prove the figures."))

    add(("lead",
         "Every module in POLYTOS posts to one double-entry ledger kept on a cash basis. This "
         "chapter is that ledger, and the screens that read and write it."))

    add(("h2", "18.1  The chart of accounts"))
    add(("p",
         "An account code identifies one line of the books. Codes ending in a branch code "
         "(`1010-BR2602`) belong to one branch, because cash is the only thing that is "
         "physically somewhere. Everything else is company-wide and sliced by branch through the "
         "entry."))
    add(("table", ["Code", "Account", "Type", "What it holds"],
         [
             ["`1010-BR…`", "Cash at Hand", "Asset", "Physical money in the branch till"],
             ["`1020-BR…`", "MTN Mobile Money", "Asset", "The business's own MTN wallet"],
             ["`1030-BR…`", "Airtel Money", "Asset", "The business's own Airtel wallet"],
             ["`1040-BR…`", "Cash at Bank", "Asset", "The branch's bank account"],
             ["`1050-BR…`", "Cash in Transit", "Asset", "Cash banked but not yet confirmed by the bank"],
             ["`1200`", "Loans Receivable", "Asset", "Principal still owed by borrowers"],
             ["`1310`", "Agency Commission Receivable", "Asset", "Commission earned, not yet remitted"],
             ["`1320.<PROVIDER>.<BRANCH>.<TILL>`", "Agency float", "Asset",
              "Electronic value held with one provider on one till"],
             ["`2100`", "Member Savings", "Liability", "Money owed back to members"],
             ["`2210` / `2220` / `2290`", "Agency payables", "Liability",
              "Money held on somebody else's behalf"],
             ["`2300`–`2330`", "Borrowings", "Liability", "Money lent **to** the business"],
             ["`3000`", "Owner Capital", "Equity", "The owner's own money in the business"],
             ["`4100` / `4200`", "Interest and Penalty Income", "Income", "Lending income, when collected"],
             ["`4510`–`4590`", "Agency commission income", "Income", "Commission, by service kind"],
             ["`5010`–`5900`", "Operating expenses", "Expense", "Rent, salaries, transport and the rest"],
             ["`5950` / `5960`", "Cash / Float Over and Short", "Expense",
              "Reconciliation variances written off"],
         ],
         T.next("The parts of the chart of accounts a user meets.")))
    add(("figure", OPS("26-ledger"),
         F.next("The general ledger (desktop)"),
         "Every posting, newest first, with the entry it belongs to and what produced it. "
         "Readable by all three staff roles; it is the audit route for any figure on any screen."))

    add(("h2", "18.2  Cash position"))
    add(("figures2", OPS("24-cash-position"), M("11-Finance", "finance-cash-position", "owner"),
         F.next("The cash position (desktop and mobile)"),
         "Where the money is right now, by branch and by kind: cash at hand, the two wallets, "
         "the bank, cash in transit and the agency floats. This is the first screen to open in "
         "the morning and the last to check at night."))

    add(("h2", "18.3  Banking cash"))
    add(("p",
         "Banking cash is a **two-stage** movement, because handing notes to a cashier at a bank "
         "is not the same as the bank crediting the account."))
    add(("table", ["Stage", "What happens", "The posting"],
         [
             ["Recorded", "The cash leaves the till for the bank",
              "Dr Cash in Transit `1050-BR…` / Cr Cash at Hand `1010-BR…`"],
             ["Cleared", "A second person confirms the bank credited it",
              "Dr Cash at Bank `1040-BR…` / Cr Cash in Transit `1050-BR…`"],
             ["Returned to till", "It never reached the bank and the notes came back",
              "Dr Cash at Hand `1010-BR…` / Cr Cash in Transit `1050-BR…`"],
         ],
         T.next("Banking cash, and why there is a Cash in Transit account.")))
    add(("figures2", OPS("02-bank-deposit-before"), OPS("03-bank-deposit-filled"),
         F.next("The bank deposit register, and a deposit being recorded (desktop)")))
    add(("figures2", OPS("05-bank-deposit-awaiting"), OPS("07-bank-deposit-cleared"),
         F.next("A deposit awaiting confirmation, and the same deposit cleared (desktop)"),
         "Clearing it needs the **bank's own reference** and the **value date** the bank gave it. "
         "The value date may not be earlier than the day the cash left the till, and may not be "
         "in the future — POLYTOS refuses both."))
    add(("callout", "control", "The person who banked it cannot clear it",
         "Clearing is the confirmation that the money arrived. The person who carried it is not "
         "the person who confirms it arrived. If a deposit is never confirmed and the notes come "
         "back, open an investigation and then confirm the physical return — the cash goes back "
         "to the till and the record shows what happened."))

    add(("h2", "18.4  Transfers, expenses and other income"))
    add(("figures2", D("11-Finance", "finance-transfers", "owner"), D("11-Finance", "finance-transfers-new", "manager"),
         F.next("The transfer register and a new transfer (desktop)"),
         "A transfer moves money between two of the business's own accounts. It is recorded by "
         "one person and approved by another; until it is approved nothing has moved."))
    add(("figures2", D("11-Finance", "finance-expenses", "owner"), D("11-Finance", "finance-expenses-new", "manager"),
         F.next("The expense register and a new expense (desktop)"),
         "An expense is chosen from the configured categories — rent, salaries, transport, "
         "utilities, stationery, internet and airtime, mobile money charges, bank charges, fuel, "
         "repairs — so the expense reports add up without anybody typing a category name."))
    add(("figure", D("11-Finance", "finance-income", "owner"),
         F.next("Other income (desktop)"),
         "Income that is not interest, not a penalty and not agency commission: application "
         "fees, processing fees, registration fees, documentation fees and anything else."))

    add(("h2", "18.5  Capital introduced"))
    add(("p",
         "What the business was started and funded with. It distinguishes two things that are "
         "easy to confuse and must never be mixed:"))
    add(("table", ["", "Equity — the owner's own money", "Borrowing — somebody else's"],
         [
             ["Repayable?", "No", "Yes"],
             ["Interest?", "No", "Possibly"],
             ["What it credits", "`3000` Owner Capital", "A `2300`-series liability"],
             ["Effect on net worth", "Rises by the whole amount", "Unchanged — an asset and a "
              "liability arrived together"],
         ],
         T.next("Equity and borrowing. Recording one as the other misstates the business's net "
                "worth by the whole amount.")))
    add(("figures2", D("18-Walkthrough", "07-capital-empty"), D("18-Walkthrough", "12-capital-verified"),
         F.next("The Capital screen before anything is recorded, and after a contribution has "
                "been verified (desktop)")))
    add(("callout", "control", "Recording capital posts nothing",
         "A capital contribution is the largest single entry the business will ever make and the "
         "least self-correcting — a short till shows up at the next cash count, but an equity "
         "credit that is wrong shows up nowhere. So one person records what the evidence says "
         "and a **different Owner** checks it against that evidence, and the check is what writes "
         "the journal entry."))
    add(("callout", "warning", "A defect you will meet here",
         "Recording an **equity** contribution on this screen is refused: the form reports "
         "*Please check the highlighted fields* and highlights nothing, because the error is "
         "attached to a field the equity form does not display. A **borrowing** records "
         "normally. This is finding **F-04**; until it is fixed, an equity contribution has to be "
         "recorded for you by whoever maintains the system. See the Administrator Manual, "
         "Chapter 5."))

    add(("h2", "18.6  Reconciliation"))
    add(("figures2", D("11-Finance", "finance-reconciliation", "owner"),
         D("11-Finance", "finance-reconciliation-new", "manager"),
         F.next("The reconciliation register and a new cash count (desktop)")))
    add(("steps", [
        ("Count the physical cash.", "Do this before opening the screen, not while reading it."),
        ("Open **Finance ▸ Reconciliation ▸ New**.", ""),
        ("Choose the account and enter the counted figure.",
         "POLYTOS shows its own figure beside yours and computes the difference."),
        ("Explain the difference in the note.",
         "A difference with no explanation is what gets sent back."),
        ("Submit it.", "It is now a document waiting for a decision."),
        ("A **different** Manager or Owner approves or rejects it.",
         "You cannot approve a count you performed."),
    ]))
    add(("callout", "money", "A count does not fix anything",
         "Recording that the till is 5,000 short does not move 5,000 anywhere. The count is "
         "evidence. Writing the difference off to `5950 Cash Over and Short` is a separate, "
         "deliberate decision, and in the agency modules it needs `agency:variance_adjustment`, "
         "which only an Owner holds."))

    add(("h2", "18.7  The trial balance"))
    add(("figure", OPS("25-trial-balance"),
         F.next("The trial balance (desktop)"),
         "Every account with a balance, and the proof that total debits equal total credits. If "
         "those two figures ever differ, stop work and raise it: no ordinary operation in "
         "POLYTOS can produce an unbalanced book, so a difference means something is wrong below "
         "the application."))

    # =======================================================================
    # CHAPTER 19 — MOBILE MONEY
    # =======================================================================
    F.chapter_is(19); T.chapter_is(19)
    add(("chapter", 19, "Mobile money at the counter",
         "MTN and Airtel: the two directions money moves, what each does to cash and float, and "
         "how a transaction gets from the counter into the books."))

    add(("lead",
         "A mobile money counter is simple arithmetic done many times. Cash and float always "
         "move in opposite directions, by the same amount, and the commission is separate from "
         "both."))

    add(("h2", "19.1  The two directions"))
    add(("table", ["", "Customer **deposit** (cash in)", "Customer **withdrawal** (cash out)"],
         [
             ["What the customer does", "Hands you notes; their wallet is credited",
              "Sends you electronic value; you hand them notes"],
             ["Cash at hand", "**Increases**", "**Decreases**"],
             ["Your float", "**Decreases**", "**Increases**"],
             ["What can stop it", "Not enough float", "Not enough cash"],
             ["Commission", "Earned, and separate", "Earned, and separate"],
         ],
         T.next("Deposit and withdrawal, side by side. Learning this table is most of learning "
                "the counter.")))

    add(("h4", "A deposit of UGX 200,000"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash at Hand — Mbarara", "`1010-BR2602`", "200,000", ""],
          ["MTN float — mbarara-mtn-1", "`1320.MTN_MOMO.BR2602.T1`", "", "200,000"]],
         T.next("The principal of a MoMo deposit. Debits equal credits.")))
    add(("h4", "The commission on it, at the agreed 1.5%"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Agency Commission Receivable", "`1310`", "3,000", ""],
          ["Mobile Money Commission", "`4510`", "", "3,000"]],
         T.next("Commission is a **separate** entry posted in the same breath. It does not touch "
                "cash and it does not touch float: the provider owes it to you until they remit "
                "it.")))
    add(("callout", "money", "The single most important rule at the counter",
         "The commission is **not** part of the principal, and it does **not** increase your "
         "float when you earn it. Float only rises when a customer withdraws, when you buy more "
         "float, or when the provider settles commission into it. Treating commission as float "
         "is how a counter ends the day short."))

    add(("h2", "19.2  Recording a transaction, end to end"))
    add(("figures2", OPS("11-D1-record-before"), OPSM("11-D1-record-before"),
         F.next("The Record transaction screen before anything is entered (desktop and mobile)")))
    add(("figure", OPS("12-D1-record-filled"),
         F.next("The same screen with a UGX 200,000 MTN deposit entered (desktop)"),
         "Branch, service, amount, the customer's wallet number, the customer's name and the "
         "provider's confirmation code. The service decides the direction; you do not choose "
         "'deposit' separately."))
    add(("steps", [
        ("Open **Agency ▸ Record transaction**.",
         "Desktop: the Agency module in the rail. Mobile: menu ▸ Agency ▸ Record transaction."),
        ("Choose the branch, then the service.",
         "Only services on providers that are live, and tills you are authorised on, are offered."),
        ("Enter the amount the customer is moving.",
         "Above the service's ceiling the form refuses it."),
        ("Enter the customer identifier, and the name if asked.", ""),
        ("Complete the transaction on the provider's own handset.", "You get a confirmation code."),
        ("Enter that code as the **provider reference**.", "It is required before submission."),
        ("Press **Record transaction**, then **Submit**.",
         "The state becomes *awaiting verification*. Nothing has posted."),
        ("A Manager or Owner **verifies** it.",
         "The journals post: cash and float move, and the commission is recognised."),
    ]))
    add(("figures2", OPS("13-D1-recorded"), OPS("14-D1-draft"),
         F.next("The transaction recorded, and the draft awaiting submission (desktop)")))
    add(("figures2", OPS("15-D1-pending"), OPS("16-D1-awaiting"),
         F.next("The verification queue, and one transaction inside it (desktop)"),
         "The verifier sees who recorded it — and is refused if that is themselves."))
    add(("figure", OPS("17-D1-posted"),
         F.next("The same transaction, posted (desktop)"),
         "Only now have cash and float moved in the books."))

    add(("h2", "19.3  Checking the result"))
    add(("figures2", OPS("18-float-balances"), OPS("21-money-mtn"),
         F.next("Float and till balances, and the MTN provider screen (desktop)"),
         "The float screen is the operational answer to *can I serve the next customer?* The "
         "provider screen is the commercial one: what this partner has earned us and what it "
         "still owes."))
    add(("figures2", OPS("22-money-airtel"), M("13-MobileMoney", "money-overview", "secretary"),
         F.next("Airtel, and the mobile money overview on a phone"),
         "MTN and Airtel are separate providers with separate floats, separate commission terms "
         "and separate statements. Nothing is pooled between them, and a shortage on one is "
         "never covered by the other."))

    add(("h2", "19.4  When something goes wrong"))
    add(("table", ["Situation", "What POLYTOS does", "What you do"],
         [
             ["Not enough float for a deposit", "Refuses with *insufficient agency float*",
              "Ask for a float top-up, or move float between tills"],
             ["Not enough cash for a withdrawal", "Refuses with an insufficient-cash message",
              "Do not pay out. Bank less, or wait for collections"],
             ["Above the service ceiling", "The form refuses the amount",
              "Split it, or ask an Owner to review the ceiling"],
             ["The same provider reference twice", "Refused as a duplicate",
              "Search the history before recording it again"],
             ["Typed the wrong reference, already posted",
              "`agency:correct` changes the reference and nothing else",
              "Ask a Manager; the correction is logged with a reason"],
             ["The whole transaction was wrong, today",
              "`agency:reverse` posts a contra entry", "Ask a Manager"],
             ["The whole transaction was wrong, an earlier day",
              "Needs `agency:reverse_cross_day`", "Ask an Owner"],
             ["The commission does not match the agreed rate",
              "Raises a commission exception", "Only an Owner can authorise it"],
         ],
         T.next("Counter problems, and who can resolve each.")))

    # =======================================================================
    # CHAPTER 20 — AGENCY BANKING
    # =======================================================================
    F.chapter_is(20); T.chapter_is(20)
    add(("chapter", 20, "Agency banking",
         "Acting as a partner bank's counter: how it differs from mobile money, and the one "
         "rule that governs what you may pay out."))

    add(("h2", "20.1  Two money models, and why it matters"))
    add(("p",
         "A provider in POLYTOS holds its money in one of two ways, and the way it holds it "
         "decides what the counter may do."))
    add(("table", ["", "Electronic float", "Cash, payable to the provider"],
         [
             ["What you hold", "Float the partner has advanced you", "The customer's cash, owed onward"],
             ["Account", "`1320.<PROVIDER>.<BRANCH>.<TILL>` (an asset)", "`2200`-series (a liability)"],
             ["A deposit", "Cash up, float down", "Cash up, payable up"],
             ["A withdrawal", "Cash down, float up", "Cash down, payable down"],
             ["What limits a withdrawal", "The float you hold", "**Only what you have collected "
              "for that bank**"],
             ["Settlement", "Buy more float", "Hand the cash over to the partner"],
         ],
         T.next("The two money models. A bank may be configured either way; which one it is "
                "changes the arithmetic completely.")))
    add(("callout", "warning", "Under the cash-payable model there is no working float",
         "If a partner bank is configured as *cash, payable to the provider*, POLYTOS refuses any "
         "withdrawal larger than what that bank's own deposits have collected. There is no flag, "
         "no override and no capability that relaxes it, because paying out more would mean the "
         "business had advanced its own money on the bank's behalf — a receivable nobody has "
         "agreed to. An advance arrangement is specified in the project documents and is "
         "deliberately **not implemented**. If you want a bank counter that can pay out from a "
         "pre-funded balance, the bank must be configured on the **electronic float** model."))

    add(("h2", "20.2  A bank agency deposit"))
    add(("figures2", OPS("11-A1-record-before"), OPS("12-A1-record-filled"),
         F.next("Recording a UGX 400,000 bank agency deposit (desktop)"),
         "The customer identifier here is their **bank account number**, and the provider "
         "reference is the bank's own confirmation."))
    add(("h4", "What a UGX 400,000 deposit does, on the electronic float model"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash at Hand — Mbarara", "`1010-BR2602`", "400,000", ""],
          ["Stanbic agent float — mbarara-stanbic-1", "`1320.STANBIC.BR2602.T1`", "", "400,000"]],
         T.next("A bank agency deposit. Identical in shape to a MoMo deposit — the customer gave "
                "you notes and you sent value to their account.")))
    add(("figures2", OPS("17-A1-posted"), OPS("23-banking-overview"),
         F.next("The posted transaction, and the agent banking overview (desktop)")))

    add(("h2", "20.3  The bank agent account"))
    add(("figure", D("14-AgencySetup", "agency-banking-accounts", "owner"),
         F.next("The register of banks and agent accounts (desktop)"),
         "One row per registered agent account: the bank, the branch, the agent identifier, the "
         "partner's account number and the float account it owns. Registering one is an "
         "Owner-only act covered in the Administrator Manual, Chapter 9."))

    # =======================================================================
    # CHAPTER 21 — COMMISSIONS AND SETTLEMENT
    # =======================================================================
    F.chapter_is(21); T.chapter_is(21)
    add(("chapter", 21, "Commissions and settlement",
         "What you earned, what the provider still owes you, and what happens when they pay."))

    add(("h2", "21.1  Two commission models"))
    add(("table", ["", "Deferred", "Immediate"],
         [
             ["When income is recognised", "At the moment of the transaction",
              "At the moment of the transaction"],
             ["When the money arrives", "Later, when the provider remits it", "In the same transaction"],
             ["What it creates", "`1310` Agency Commission Receivable", "Nothing — it is already yours"],
             ["Typical of", "MTN, Airtel, partner banks", "Airtime and data"],
             ["Is there a settlement step?", "Yes", "No"],
         ],
         T.next("The two commission models POLYTOS implements.")))
    add(("figures2", OPS("19-commission"), D("13-MobileMoney", "money-mtn-commission", "owner"),
         F.next("The commission screen, and one provider's commission position (desktop)"),
         "*Commission outstanding* is what providers owe you and have not yet paid. It is an "
         "asset, not cash, and it cannot be spent."))

    add(("h2", "21.2  Settlement, and the mistake to avoid"))
    add(("p",
         "When a provider remits the commission it owes, that is a **settlement**: the "
         "receivable is cleared and the money arrives in the float or the bank. It is not new "
         "income — the income was recognised when each transaction posted."))
    add(("h4", "MTN remits UGX 25,000 of accrued commission into the float"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["MTN float", "`1320.MTN_MOMO.BR…`", "25,000", ""],
          ["Agency Commission Receivable", "`1310`", "", "25,000"]],
         T.next("A commission settlement. Note that **no income account is touched** — this is "
                "collection of something already earned.")))
    add(("callout", "money", "Never count a settlement as new commission",
         "If a settlement credited `4510` again, the same commission would be counted twice: "
         "once when the transaction posted and once when it was paid. POLYTOS does not do that, "
         "and neither should any manual reconciliation you do beside it. Commission income for a "
         "month is the sum of what was **earned** in that month, not what was **received**."))
    add(("figure", D("12-Agency", "agency-payables", "owner"),
         F.next("Provider remittances and payables (desktop)"),
         "The other side of settlement: money the business is holding that belongs to a partner, "
         "and the record of handing it over."))

    # =======================================================================
    # CHAPTER 22 — AGENCY RECONCILIATION
    # =======================================================================
    F.chapter_is(22); T.chapter_is(22)
    add(("chapter", 22, "Agency reconciliation",
         "Proving the float and the till against something that is not POLYTOS."))

    add(("p",
         "POLYTOS reconciles the agency position in three ways, each against a different "
         "independent source."))
    add(("table", ["Kind", "What is compared", "Against", "Who approves"],
         [
             ["Cash reconciliation", "Cash at hand on the agency till", "A physical count",
              "A Manager or Owner who did not perform it"],
             ["Float reconciliation", "Electronic float per till",
              "The provider's own statement", "A Manager or Owner who did not submit it"],
             ["Commission reconciliation", "Commission receivable per provider",
              "The provider's remittance statement", "`agency:reconcile`, then certification"],
         ],
         T.next("The three agency reconciliations, and the independent source each uses.")))
    add(("figures2", OPS("28-reconciliation-cash"), OPS("29-reconciliation-float"),
         F.next("Cash reconciliation and float reconciliation (desktop)")))
    add(("steps", [
        ("Open the reconciliation and read the **opening balance** POLYTOS has.", ""),
        ("Enter the **statement** or **counted** figure.", "The difference is computed for you."),
        ("Investigate anything that does not match.",
         "The usual causes: a transaction still awaiting verification, a reference entered "
         "against the wrong customer, or a provider fee POLYTOS has not been told about."),
        ("Write what you found in the note, and submit.", "It becomes a document awaiting a decision."),
        ("A **different** person reviews and approves or rejects it.",
         "POLYTOS refuses the same person on both sides."),
        ("If a difference remains and must be written off, an **Owner** does it.",
         "It posts to `5960 Agency Float Over and Short` and is recorded with a reason."),
    ]))
    add(("figure", D("12-Agency", "agency-exceptions", "owner"),
         F.next("End-of-day exceptions (desktop)"),
         "The list that says whether the day can close: transactions recorded but not posted, "
         "variances not written off, commissions that did not match the agreed rate. A day with "
         "entries here is a day whose reported figures are not the whole truth."))

    # =======================================================================
    # CHAPTER 23 — REPORTS
    # =======================================================================
    F.chapter_is(23); T.chapter_is(23)
    add(("chapter", 23, "Reports",
         "Every report POLYTOS produces, who may read it, and what each one answers."))

    add(("figure", D("15-Reports", "reports-centre", "manager"),
         F.next("The Reports Centre (desktop)"),
         "Reports are grouped by the question they answer: money in, who is behind, the book, "
         "and security."))
    add(("table", ["Report", "Answers", "Filters", "Export", "Who may read it"],
         [
             ["Collections", "What was collected, when, by whom and by what method",
              "Date range, branch", "CSV", "Manager, Owner"],
             ["Arrears", "Who is behind and by how much", "Date, branch", "CSV", "Manager, Owner"],
             ["Ageing", "The book split into ageing buckets", "Date, branch", "CSV", "Manager, Owner"],
             ["Loans", "The loan book with its terms and balances", "Stage, product, branch",
              "CSV", "Manager, Owner"],
             ["Clients", "The client register with status and exposure", "Status, branch", "CSV",
              "Manager, Owner"],
             ["Penalties", "Penalties charged, paid and outstanding", "Date range", "CSV",
              "Manager, Owner"],
             ["Grace", "Loans inside the grace window", "Date", "CSV", "Manager, Owner"],
             ["Recovery", "Recovery actions and promises", "Date range", "CSV", "Manager, Owner"],
             ["Collateral", "Security held against loans", "Branch", "CSV", "Manager, Owner"],
             ["Guarantors", "Guarantors and their total exposure", "Branch", "CSV", "Manager, Owner"],
             ["Agency reports", "Transactions, commission and float by provider and branch",
              "Date range, branch, provider", "CSV", "Manager, Owner"],
             ["Benefit reports", "Claims by type, status and member", "Date range", "—",
              "Manager, Owner"],
             ["Trial balance", "Every account balance, and the proof the book balances",
              "As at a date", "CSV", "All staff"],
         ],
         T.next("The report family. 'CSV' means the screen has an export route that produces a "
                "file you can open in a spreadsheet.")))
    add(("figures2", D("15-Reports", "reports-arrears", "manager"), D("15-Reports", "reports-aging", "manager"),
         F.next("The arrears report and the ageing report (desktop)")))
    add(("figure", OPS("27-agency-reports"),
         F.next("The agency reports screen (desktop)"),
         "Filter by date, branch and provider, then export. This is where a month's agency "
         "performance is read off."))
    add(("callout", "note", "A report is a view, not a record",
         "Every report is computed from the ledger and the registers when you open it. Two "
         "reports asking the same question will always agree, because they are reading the same "
         "rows — which also means that correcting an underlying document corrects every report "
         "that mentioned it."))

    # =======================================================================
    # CHAPTER 24 — NOTIFICATIONS, AUDIT AND SECURITY
    # =======================================================================
    F.chapter_is(24); T.chapter_is(24)
    add(("chapter", 24, "Notifications, the audit trail and account security",
         "What POLYTOS tells you, what it records about you, and how to keep your account safe."))

    add(("h2", "24.1  Notifications"))
    add(("figures2", D("01-Access", "notifications", "owner"), M("01-Access", "notifications", "manager"),
         F.next("Notifications (desktop and mobile)")))
    add(("table", ["Notification", "Raised when", "Who gets it"],
         [
             ["Float running low", "A till's float falls below its threshold", "Manager, Owner"],
             ["Reconciliation variance", "A submitted reconciliation does not balance", "Manager, Owner"],
             ["Transfer awaiting a decision", "A transfer is recorded", "Manager, Owner"],
             ["Expense awaiting a decision", "An expense is recorded", "Manager, Owner"],
             ["Loan awaiting approval", "An application is submitted", "Manager, Owner"],
             ["Withdrawal request", "A member withdrawal is prepared", "Manager, Owner"],
             ["Benefit claim awaiting assessment", "A claim is recorded", "Manager, Owner"],
             ["Something still waiting", "An item has sat undecided", "Whoever can decide it"],
         ],
         T.next("The notifications POLYTOS raises. All are generated by state changes; none is "
                "written by a person.")))

    add(("h2", "24.2  The audit trail"))
    add(("figures2", OPS("30-audit"), D("16-Administration", "audit-agency", "owner"),
         F.next("The audit trail, and the same trail filtered to agency transactions (desktop)"),
         "Every configuration change, approval, reversal and status change, with the person who "
         "made it and when. Filtering by entity is how the rail's 'Client History', 'Loan "
         "History' and 'Membership History' entries work — they are this screen with a filter."))
    add(("callout", "note", "Only the Owner / Administrator can read it",
         "`audit:view` is held by the Owner / Administrator alone. There is no read-only "
         "oversight role in this release (finding **F-06**): an external auditor is given an "
         "Owner / Administrator account, which also carries the ability to change things."))

    add(("h2", "24.3  Keeping your account safe"))
    add(("bullets", [
        "**Your password identifies you in the books.** Every posting carries the name of "
        "whoever made it, and that is what maker-checker relies on. Sharing a password destroys "
        "both controls at once.",
        "**Change a temporary password immediately.** POLYTOS will not let you past the password "
        "screen until you do.",
        "**Sign out at the end of a shift**, especially on a shared counter machine.",
        "**Repeated wrong passwords are rate-limited**, and repeated sign-ins from the same "
        "account in a short window are slowed deliberately. This is not a fault.",
        "**Nobody will ever ask you for your password** — not a colleague, not an administrator, "
        "not whoever supports the system.",
    ]))

    # =======================================================================
    # CHAPTER 25 — TROUBLESHOOTING
    # =======================================================================
    F.chapter_is(25); T.chapter_is(25)
    add(("chapter", 25, "Troubleshooting",
         "The messages POLYTOS gives you, in plain words, with what to do about each."))

    add(("h2", "25.1  Signing in"))
    add(("table", ["What you see", "What it means", "What to do"],
         [
             ["The password is refused and you are sure it is right",
              "The account may be suspended, or the number may be typed differently",
              "Try `+256…` and `0…`; then ask your administrator to check the account status"],
             ["Sign-in hangs or is very slow after several attempts",
              "Rate limiting, which is deliberate", "Wait five minutes and try once"],
             ["You are taken straight to a password screen",
              "You were issued a temporary password", "Change it; you cannot go anywhere until you do"],
             ["You sign in and land somewhere unexpected",
              "Your landing screen depends on your role", "A borrower lands in the portal; staff land on the dashboard"],
         ],
         T.next("Sign-in problems.")))

    add(("h2", "25.2  Being refused"))
    add(("table", ["What you see", "What it means", "What to do"],
         [
             ["*You do not have permission to do this*", "Your role does not hold the capability",
              "This is correct. Ask the role that does — Chapter 6 says which"],
             ["*A different authorized officer must complete this action*",
              "Maker-checker: you are on the wrong side of a two-person control",
              "Ask a colleague with the right role"],
             ["*You recorded this …, so you cannot verify it*", "The same rule, stated plainly",
              "Ask somebody else"],
             ["*… is still provisional*", "The provider's terms have not been approved",
              "An Owner must approve them before anything can be posted"],
             ["*… has no open agent account*", "The provider is live but has no till",
              "An Owner must register one"],
             ["*That branch is not available to you*", "You are scoped to a different branch",
              "Ask your administrator"],
         ],
         T.next("Refusals, and what each one is protecting.")))

    add(("h2", "25.3  Money problems"))
    add(("table", ["What you see", "What it means", "What to do"],
         [
             ["*insufficient agency float*", "The till has not got the electronic value",
              "Top the float up, or move float from another till"],
             ["An insufficient-cash message", "The branch cannot cover the payout",
              "Do not pay out"],
             ["The balance on screen is less than the money in the drawer",
              "Transactions are recorded but not verified",
              "Get them verified; they have posted nothing until then"],
             ["A reconciliation will not balance by a round figure",
              "Usually a single unposted or mis-keyed transaction",
              "Check today's transaction history before writing anything off"],
             ["Commission looks too small", "Commission is per transaction at the agreed rate",
              "Check the provider's rate on the provider screen"],
             ["A deposit has been banked but the bank balance has not moved",
              "It is in Cash in Transit until somebody confirms it arrived",
              "A Manager or Owner clears it with the bank's reference"],
         ],
         T.next("Money that does not look right.")))

    add(("h2", "25.4  Screens that do not work"))
    add(("table", ["What you see", "What is happening", "What to do"],
         [
             ["A member's own page fails for a Secretary / Treasurer",
              "Known defect **F-02** — a panel the role may not read is not handled",
              "Work from the register; ask a Manager to open the member's page"],
             ["Recording **equity** capital is refused with nothing highlighted",
              "Known defect **F-04**", "Record it as a borrowing if that is what it is, or ask "
              "whoever maintains the system"],
             ["The commission **Rate** box refuses every value",
              "Known defect **F-09**",
              "Register the provider as reporting its own commission, or ask for the rate to be set"],
             ["A page is blank where you expected figures", "There is nothing to show yet",
              "Check the filters, especially date and branch"],
         ],
         T.next("Known defects a user may meet. The full list is in the findings report beside "
                "this manual.")))

    # =======================================================================
    # CHAPTER 26 — FAQ
    # =======================================================================
    F.chapter_is(26); T.chapter_is(26)
    add(("chapter", 26, "Frequently asked questions", ""))
    add(("kv", [
        ("Is there an Android or iPhone app?",
         "No. POLYTOS is a web application. On a phone you open the same address in the phone's "
         "browser; the layout rearranges itself to fit."),
        ("Can I work offline?",
         "The application can be installed to a phone's home screen and shows an offline notice "
         "when there is no network, but recording transactions needs a connection."),
        ("Why can I not see the Finance menu?",
         "You see a module only if your role has something to do in it. Chapter 6 lists who sees "
         "what."),
        ("Why does the dashboard say we collected less than the till holds?",
         "Almost always because transactions are recorded but not yet verified. Until a second "
         "person verifies them they have posted nothing."),
        ("I recorded a payment against the wrong loan. Can I edit it?",
         "No. Payments are immutable. An Owner reverses it and a correct one is recorded; both "
         "stay on the record."),
        ("Why can I not approve my own cash count?",
         "Because a count is only evidence if somebody else agrees with it. POLYTOS enforces "
         "this in the database, so no screen can skip it."),
        ("The provider paid us commission. Is that income?",
         "No — it was income when each transaction posted. The payment clears the receivable. "
         "Counting it again would double the month's commission."),
        ("Can one person hold two roles?",
         "Yes, and they then have everything either role allows. There are no deny rules."),
        ("Can we add a role of our own?",
         "Not in this release. POLYTOS implements four roles; people are given whichever one "
         "carries the capabilities their job needs."),
        ("What is the business day, and why is it not today's date?",
         "It is the trading date POLYTOS posts against, shown in the top bar. It is set by the "
         "system, not by your device, so that a branch working past midnight still posts to the "
         "right day."),
        ("We have more than one MTN line. Is that supported?",
         "Yes. Each line is a separate till with its own float account, its own authorised staff "
         "and its own reconciliation."),
        ("Does POLYTOS talk to MTN or Airtel directly?",
         "No. There is no provider API integration in this release. The counter completes the "
         "transaction on the provider's own handset and records the confirmation code here."),
        ("Who can see a client's national identification number?",
         "Only roles holding `clients:view_nin`. Everybody else sees it masked."),
        ("How do I get a report into Excel?",
         "Most reports have an export control that produces a CSV file, which Excel opens "
         "directly."),
    ]))

    # =======================================================================
    # CHAPTER 27 — GLOSSARY
    # =======================================================================
    F.chapter_is(27); T.chapter_is(27)
    add(("chapter", 27, "Glossary",
         "The words POLYTOS uses, in the sense it uses them."))
    add(("kv", GLOSSARY))

    # =======================================================================
    # CHAPTER 28 — INDEX
    # =======================================================================
    F.chapter_is(28); T.chapter_is(28)
    add(("chapter", 28, "Where to find things",
         "A topic index into this manual and into the application."))
    add(("table", ["If you want to …", "Chapter", "In the application"],
         [
             ["sign in, or change your password", "1", "Administration ▸ My Account"],
             ["know what your role may do", "2–6", "—"],
             ["read the dashboard figures", "8", "Dashboard"],
             ["register a borrower", "9", "Clients ▸ New Client"],
             ["register a guarantor", "9", "Clients ▸ Guarantor Register"],
             ["enrol a member", "10", "Membership ▸ Enrol a Member"],
             ["take a savings deposit", "11", "Member Savings ▸ (the member) ▸ Deposit"],
             ["decide a savings withdrawal", "11", "Member Savings ▸ Withdrawal Requests"],
             ["see who can borrow against savings", "12", "Member Lending ▸ Who Can Borrow"],
             ["record a welfare claim", "13", "Member Benefits ▸ Benefit Claims"],
             ["convene a meeting or collect a fine", "14", "Meetings"],
             ["take a loan application", "15", "Loan Management ▸ New Loan Application"],
             ["approve or disburse a loan", "15", "Loan Management ▸ Pending Approval"],
             ["record a repayment", "16", "Collections ▸ Record a payment"],
             ["work the arrears list", "16", "Collections ▸ Overdue"],
             ["record a recovery action", "17", "Debt & Security ▸ Recovery"],
             ["see where the money is", "18", "Finance ▸ Cash Position"],
             ["bank cash", "18", "Finance ▸ Bank Deposits"],
             ["record an expense", "18", "Finance ▸ Expenses"],
             ["record capital introduced", "18", "Finance ▸ Capital"],
             ["do a cash count", "18", "Finance ▸ Reconciliation"],
             ["prove the books balance", "18", "Finance ▸ Trial Balance"],
             ["record a mobile money transaction", "19", "Agency ▸ Record transaction"],
             ["verify somebody else's transaction", "19", "Agency ▸ Pending verification"],
             ["check a till's float", "19", "Agency ▸ Float and till balances"],
             ["run a bank agency counter", "20", "Agency ▸ Agent Banking"],
             ["see what providers owe us", "21", "Agency ▸ Commissions"],
             ["reconcile float against a statement", "22", "Agency ▸ Float reconciliation"],
             ["close the day cleanly", "22", "Agency ▸ End-of-day exceptions"],
             ["run a report", "23", "Reports ▸ Reports Centre"],
             ["see who did what", "24", "Administration ▸ Audit Trail"],
             ["understand an error message", "25", "—"],
         ],
         T.next("Topic index.")))

    return B
