"""
POLYTOS Complete User & Operations Manual — Part A.

Chapters 1 to 7: the system, and then every role that exists in it.
"""

from content_common import (
    BRANCHES, D, GLOSSARY, M, ORG, PEOPLE, ROLE_SUMMARY, Figures, Tables,
)

F = Figures()
T = Tables()


def blocks():
    B = []
    add = B.append

    # =======================================================================
    # CHAPTER 1
    # =======================================================================
    F.chapter_is(1); T.chapter_is(1)
    add(("chapter", 1, "Introduction to POLYTOS",
         "What the system is for, who uses it, how to get into it, and how to find your way "
         "around once you are in. Read this chapter once; the rest of the manual assumes it."))

    add(("lead",
         "POLYTOS is a single place to run a small Ugandan financial business: the money you "
         "lend, the money members save, the agency services you sell over the counter, and the "
         "books that have to add up at the end of the day."))

    add(("h2", "1.1  What POLYTOS does"))
    add(("p",
         "POLYTOS Management System brings five kinds of work into one application, all posting "
         "to one set of books:"))
    add(("bullets", [
        "**Lending.** Borrower registration, guarantors, loan applications, approval, "
        "disbursement, repayment schedules, collections, arrears, penalties and recovery.",
        "**Membership and member finance.** Enrolling members, their savings accounts, member "
        "loans assessed against savings, welfare benefit claims, and member meetings with "
        "attendance fines.",
        "**Agency services.** Mobile money over the counter for MTN and Airtel, agency banking "
        "for partner banks, utility bills, television subscriptions, airtime and school fees.",
        "**Finance.** Capital introduced, cash and bank accounts, transfers, expenses, other "
        "income, banking of cash, daily reconciliation, the general ledger and the trial "
        "balance.",
        "**Oversight.** Dashboards, a large family of reports, notifications, and an audit "
        "trail that records who did what.",
    ]))
    add(("callout", "note", "One book, not five",
         "Every one of those modules writes to the same double-entry ledger. A mobile money "
         "deposit and a loan repayment land in the same trial balance, which is why the figures "
         "on the dashboard, in the reports and in the ledger always agree."))

    add(("h2", "1.2  Who uses it"))
    add(("p",
         "POLYTOS has **four roles**. There is no separate cashier role, no separate auditor "
         "role and no separate accountant role: those jobs are done by the roles below, and this "
         "manual says under each one exactly which of those jobs it covers."))
    add(("table",
         ["Role", "Key", "Rank", "Staff?", "What it is for"],
         [[r[0], f"`{r[1]}`", str(r[2]), r[3], r[4]] for r in ROLE_SUMMARY],
         T.next("The four roles POLYTOS implements.")))
    add(("p",
         "Rank decides two things only: the order roles appear in, and the rule that an "
         "administrator may not grant a role higher than their own. It does **not** mean a "
         "Manager automatically gets everything a Secretary has — each role's abilities are "
         "listed one by one, and a new ability belongs to nobody until somebody grants it."))
    add(("p",
         "One person may hold more than one role. When they do, they can do everything any of "
         "their roles allows; there is no way for one role to take away what another gives."))

    add(("h2", "1.3  Getting in"))
    add(("p",
         "POLYTOS runs in a web browser. There is no separate program to install, and there is "
         "no Android or iPhone application — on a phone you open the same address in the phone's "
         "browser and the screen rearranges itself to fit."))
    add(("figure", D("01-Access", "login", "anon"),
         F.next("The sign-in screen (desktop)"),
         "You sign in with your **phone number** and your **password** — not an email address. "
         "The eye button at the right of the password box shows what you have typed, which is "
         "worth using on a phone keyboard. If you have forgotten your password there is no "
         "self-service reset: your administrator issues a new one."))
    add(("steps", [
        ("Open the POLYTOS address your administrator gave you.",
         "The sign-in screen appears."),
        ("Type your phone number in the first box.",
         "Either `0772 123 456` or `+256 772 123 456` is accepted."),
        ("Type your password in the second box.",
         "The characters are hidden until you press the eye button."),
        ("Press **Sign in**.",
         "Your home screen opens. Which screen that is depends on your role."),
    ]))
    add(("callout", "warning", "The first time you sign in",
         "If your administrator issued you a temporary password, POLYTOS will not let you go "
         "anywhere until you have changed it. You will be taken straight to the password screen. "
         "This is not optional and it cannot be skipped — see §1.5."))

    add(("h2", "1.4  Finding your way around"))
    add(("p",
         "The screen is in three parts: a **navigation rail** down the left, a **top bar** across "
         "the top, and the page itself in the middle."))
    add(("figure", D("01-Access", "dashboard", "owner"),
         F.next("The dashboard and the navigation rail (desktop, Owner / Administrator)"),
         "The rail groups every screen into modules — Clients, Membership, Member Savings, "
         "Member Lending, Member Benefits, Meetings, Loan Management, Collections, Debt & "
         "Security, Finance, Agency, Reports, Branch Network and Administration. A module you "
         "have no business in is not drawn at all, so two people with different roles see rails "
         "of different lengths."))
    add(("p",
         "The top bar shows the **business day** POLYTOS is posting against, the organisation "
         "name, a search button, a refresh button, the notification bell with a count of what is "
         "waiting for you, and your own name."))
    add(("callout", "note", "The business day is not your device's clock",
         "POLYTOS posts against the business day shown in the top bar. If your laptop's date is "
         "wrong, the business day does not change. Always read the date from the top bar before "
         "you record anything."))

    add(("h3", "On a phone"))
    add(("p",
         "At phone width the rail collapses behind the **menu button** at the top left, tables "
         "become stacked cards, and the figures that matter move to the top of the screen. "
         "Everything is still there; it is arranged in one column instead of several."))
    add(("figures2", M("01-Access", "dashboard", "owner"), M("12-Agency", "agency-overview", "secretary"),
         F.next("The dashboard and the Agency hub (mobile)"),
         "Left: the dashboard at 390 points wide. Right: the Agency hub as a Secretary / "
         "Treasurer sees it. Note the hamburger menu at the top left of each — that is where the "
         "navigation rail has gone."))
    add(("callout", "note", "Desktop and mobile instructions in this manual",
         "Where the two differ, this manual gives both. **Desktop:** *open the Finance module in "
         "the left rail and choose Capital.* **Mobile:** *press the menu button, open Finance, "
         "then choose Capital.* Everything after that point is identical."))

    add(("h2", "1.5  Your password and your account"))
    add(("p",
         "Your own details live under **Administration ▸ My Account**. You can change your "
         "password there at any time."))
    add(("figures2", D("01-Access", "account", "owner"), D("01-Access", "account-password", "owner"),
         F.next("My Account, and the password screen (desktop)"),
         "Changing your password asks for the current one as well as the new one. That is "
         "deliberate: it means somebody who finds your screen unlocked still cannot lock you out "
         "of your own account."))
    add(("bullets", [
        "**Never share your password.** Every financial posting in POLYTOS is stamped with the "
        "person who made it, and that stamp is what the audit trail relies on.",
        "**Sign out when you leave the counter.** The sign-out button is at the bottom of the "
        "rail on a desktop and in the top bar on a phone.",
        "**Repeated wrong passwords lock the account.** Ask your administrator to clear it; "
        "there is no way to wait it out at the counter.",
    ]))

    add(("h2", "1.6  Notifications"))
    add(("p",
         "The bell in the top bar counts the things waiting on you — a transfer to decide, a "
         "withdrawal request, a float running low, a reconciliation variance, a loan awaiting "
         "approval. Opening **Notifications** lists them in full."))
    add(("figure", D("01-Access", "notifications", "owner"),
         F.next("The notification list (desktop)"),
         "Notifications are generated by the system when a state changes, not written by a "
         "person. They are a prompt to go and look, not a record — the record is the document "
         "itself and the audit trail."))

    add(("h2", "1.7  The words this manual uses"))
    add(("p",
         "A handful of terms appear on nearly every screen. The full glossary is at the back of "
         "this manual; these six are worth learning before you go further."))
    add(("kv", [
        ("Cash at hand",
         "The physical money in your branch's till. It goes **up** when a customer gives you "
         "notes and **down** when you pay notes out."),
        ("Float",
         "Electronic value you hold with MTN, Airtel or a partner bank. It goes **down** when a "
         "customer deposits (you send them value) and **up** when a customer withdraws (they "
         "send you value). Float and cash always move in opposite directions."),
        ("Commission",
         "What the provider pays you for handling the transaction. It is never part of the "
         "amount the customer moved, and it does not reach your float until the provider settles "
         "it."),
        ("Payable",
         "Money you are holding that belongs to somebody else — a school's fees, a partner "
         "bank's deposits. It is a debt you owe, not income you have earned."),
        ("Reconciliation",
         "Counting or reading a balance independently, comparing it with what POLYTOS says, "
         "explaining the difference, and having a second person agree."),
        ("Posting",
         "Writing the entry into the books. Most money documents in POLYTOS are *recorded* by "
         "one person and only *post* when a second person verifies them."),
    ]))

    add(("h2", "1.8  The demonstration organisation in this manual"))
    add(("p",
         f"Every screenshot in this manual was taken from a running POLYTOS system configured as "
         f"**{ORG}**, a fictional business created solely for this documentation. No real "
         f"customer, staff member, telephone number, bank account or agent number appears "
         f"anywhere in it."))
    add(("table", ["Branch code", "Branch", "Location", "District", "Opened"],
         [[f"`{c}`", n, l, d, o] for c, n, l, d, o in BRANCHES],
         T.next("The demonstration organisation's three branches.")))
    add(("table", ["Name", "Role", "Phone", "Branch"],
         [[n, r, p, b] for n, r, p, b in PEOPLE],
         T.next("The demonstration staff and the borrower whose portal is shown.")))

    # =======================================================================
    # CHAPTER 2 — OWNER / ADMINISTRATOR
    # =======================================================================
    F.chapter_is(2); T.chapter_is(2)
    add(("chapter", 2, "The Owner / Administrator",
         "The highest role in POLYTOS. What it can do directly, what it must still ask a second "
         "person to approve, and the handful of things even it cannot do."))

    add(("lead",
         "The Owner / Administrator holds 129 of the system's 130 capabilities. The one it does "
         "not hold is `portal:view`, which belongs to borrowers — and that is the pattern of the "
         "whole role: it can configure and oversee everything, but it is still bound by the "
         "controls it configured."))

    add(("h2", "2.1  What this role is for"))
    add(("bullets", [
        "Setting up the organisation, its branches, its staff and their roles.",
        "Configuring loan products, lending rules, guarantor rules, finance settings and "
        "reference numbering.",
        "Registering agency providers, approving their commercial terms and activating them.",
        "Registering agent lines and bank agent accounts, and authorising who may trade them.",
        "Recording and verifying capital, deciding transfers and expenses, and settling "
        "commission and payables.",
        "Reversing postings, authorising commission exceptions and writing off variances.",
        "Reading the general ledger, the trial balance and the audit trail — which no other "
        "role can see in full.",
    ]))

    add(("h2", "2.2  Where the Owner lands, and what the rail shows"))
    add(("figure", D("01-Access", "dashboard", "owner"),
         F.next("The Owner / Administrator's dashboard (desktop)"),
         "Every module in the rail is visible. The dashboard itself is the widest in the system: "
         "the business summary, what was charged against what was collected, today's expected "
         "and collected figures, the loan book by status, late-payment charges, portfolio at "
         "risk, member savings, promises and follow-ups, and anything awaiting a decision."))
    add(("figure", M("01-Access", "dashboard", "owner"),
         F.next("The same dashboard on a phone"),
         "The cards stack into one column in the same order. Nothing is dropped."))

    add(("h2", "2.3  The things only the Owner can do"))
    add(("p",
         "These capabilities are held by the Owner / Administrator alone. If you are reading this "
         "manual as a Manager and a control described below is not on your screen, this is why."))
    add(("table", ["Capability", "What it lets you do", "Where"],
         [
             ["`users:create`", "Register a new staff account", "Administration ▸ Users ▸ New"],
             ["`users:assign_role`", "Grant or remove a role", "Administration ▸ Users ▸ the person"],
             ["`users:disable`", "Suspend or restore an account", "Administration ▸ Users ▸ the person"],
             ["`users:reset_password`", "Issue a temporary password", "Administration ▸ Users ▸ the person"],
             ["`settings:update`", "Change company, lending, guarantor, finance and reference settings", "Administration ▸ Company Settings"],
             ["`audit:view`", "Read the audit trail", "Administration ▸ Audit Trail"],
             ["`capital:verify`", "Verify capital, which is what posts it", "Finance ▸ Capital"],
             ["`capital:reverse`", "Reverse a verified capital entry", "Finance ▸ Capital"],
             ["`loans:disburse`", "Pay a loan out", "Loan Management ▸ the loan"],
             ["`payments:reverse`", "Reverse a repayment", "Collections ▸ the payment"],
             ["`agency:providers`", "Register providers and agent lines", "Agency ▸ Register a bank / an agent account"],
             ["`agency:provider_approval`", "Approve a provider's commercial terms", "Agency ▸ Banks & Agent Accounts"],
             ["`agency:commission_exception`", "Authorise a commission that does not match the agreed rate", "Agency ▸ End-of-day exceptions"],
             ["`agency:variance_adjustment`", "Write off a reconciliation variance", "Agency ▸ Cash / Float reconciliation"],
             ["`agency:reverse_cross_day`", "Reverse a transaction posted on an earlier day", "Agency ▸ Transaction history"],
             ["`fines:reverse`", "Reverse a meeting fine", "Meetings ▸ Fines"],
             ["`savings:reverse`", "Reverse a savings transaction", "Member Savings ▸ the account"],
             ["`membership_policy:manage`", "Publish a membership policy version", "Membership ▸ Membership Policy"],
         ],
         T.next("Capabilities held by the Owner / Administrator and by nobody else.")))

    add(("h2", "2.4  What the Owner still cannot do alone"))
    add(("p",
         "POLYTOS enforces separation of duties as a **database constraint**, not as a hidden "
         "button. That means it applies to the Owner exactly as it applies to everybody else, "
         "and no screen, no setting and no support route can switch it off."))
    add(("callout", "control", "Maker-checker, enforced in the database",
         "The person who **records** a document may not be the person who **verifies** it. The "
         "person who verifies it may not be the person who **reverses** it. If you record "
         "something and then try to approve your own work, POLYTOS refuses the second action and "
         "says so. With only one Owner account in the organisation, capital cannot be posted at "
         "all — which is why a second Owner is part of the go-live checklist."))
    add(("table", ["Action", "Who records", "Who approves", "Rule"],
         [
             ["Capital introduced", "Manager or Owner", "A **different** Owner", "`capital:verify`; verifier ≠ recorder"],
             ["Agency transaction", "Any counter staff", "A **different** Manager or Owner", "`agency:verify`; verifier ≠ submitter"],
             ["High-value agency transaction", "Any counter staff", "A different Manager or Owner holding `agency:verify_high_value`", "Above the service's threshold"],
             ["Cash reconciliation", "Anybody who may perform it", "A **different** Manager or Owner", "`reconciliation:approve`; approver ≠ performer"],
             ["Transfer between accounts", "Manager or Owner", "A **different** Manager or Owner", "`transfers:approve`"],
             ["Expense", "Any staff member", "Manager or Owner", "`expenses:approve`"],
             ["Bank deposit of cash", "Any staff member", "Manager or Owner", "`deposits:verify`"],
             ["Loan", "Secretary / Treasurer", "Manager or Owner approves; Owner disburses", "Approval and disbursement are separate"],
         ],
         T.next("Every two-person control in POLYTOS, and who stands on each side of it.")))

    add(("h2", "2.5  A working day as the Owner"))
    add(("steps", [
        ("Sign in and read the dashboard's *Awaiting a decision* panel.",
         "It lists every transfer, expense and cash count that needs somebody to decide."),
        ("Open **Notifications** and clear anything addressed to you.",
         "Low float, reconciliation variances and pending approvals appear here first."),
        ("Open **Agency ▸ Pending verification**.",
         "Counter transactions recorded but not yet posted. Verify what is correct, return what "
         "is not."),
        ("Open **Finance ▸ Cash Position**.",
         "Cash, wallets, bank and agency float across every branch, in one view."),
        ("Open **Finance ▸ Reconciliation** and approve yesterday's counts.",
         "A count you performed yourself cannot be approved by you."),
        ("Read **Finance ▸ Trial Balance**.",
         "Debits and credits must be equal. If they are not, stop and investigate before "
         "anything else."),
        ("Scan **Administration ▸ Audit Trail** for anything unexpected.",
         "Every configuration change, approval and reversal is listed with the person who made "
         "it."),
    ]))
    add(("figures2", D("11-Finance", "finance-cash-position", "owner"),
         D("11-Finance", "finance-trial-balance", "owner"),
         F.next("Cash Position and Trial Balance (desktop, Owner)"),
         "The Cash Position screen is the operational view — where the money is right now. The "
         "Trial Balance is the proof — every account, and the demonstration that debits equal "
         "credits."))

    add(("h2", "2.6  Typical mistakes, and what POLYTOS says"))
    add(("table", ["What you tried", "What you will see", "What to do"],
         [
             ["Verify a document you recorded yourself",
              "The action is refused with a separation-of-duties message",
              "Ask the other Owner or a Manager to verify it"],
             ["Reverse an agency transaction from an earlier day",
              "Refused unless you hold `agency:reverse_cross_day`",
              "An Owner may do it; a Manager may only reverse the same day"],
             ["Post against a provider whose terms are not approved",
              "*… is still provisional: its commission terms have not been confirmed*",
              "Approve the terms first (Manual Two, Chapter 7)"],
             ["Pay out more float than the till holds",
              "*insufficient agency float*",
              "Replenish the float before trading"],
             ["Change a provider's float model after it has traded",
              "Refused, naming the posted history",
              "Settle the old position with your accountant first"],
         ],
         T.next("Refusals an Owner meets most often.")))

    # =======================================================================
    # CHAPTER 3 — MANAGER
    # =======================================================================
    F.chapter_is(3); T.chapter_is(3)
    add(("chapter", 3, "The Manager",
         "The supervising role: 96 of the 130 capabilities. A Manager approves other people's "
         "work, and almost never records the work itself."))

    add(("lead",
         "If you are a Manager, most of your day is spent on the *second* half of two-person "
         "controls — verifying agency transactions, approving loans, deciding transfers and "
         "expenses, approving reconciliation, and reading the reports that tell you whether the "
         "branch is holding together."))

    add(("h2", "3.1  What a Manager can do that a Secretary cannot"))
    add(("table", ["Capability", "What it lets you do"],
         [
             ["`loans:approve`", "Approve or reject a loan application"],
             ["`loans:cancel`", "Cancel an application that will not proceed"],
             ["`agency:verify`", "Post a counter transaction somebody else recorded"],
             ["`agency:verify_high_value`", "Post one above the service's approval threshold"],
             ["`agency:reverse`", "Reverse a same-day counter transaction"],
             ["`agency:correct`", "Correct a provider reference after posting"],
             ["`agency:settlements`", "Record commission and payable settlements, and float top-ups"],
             ["`agency:reconcile`", "Submit and approve agency cash and float reconciliation"],
             ["`agency:reports`", "Read the agency report family"],
             ["`transfers:approve`", "Decide a transfer between accounts"],
             ["`expenses:approve`", "Decide an expense"],
             ["`deposits:verify`", "Confirm cash banked actually reached the bank"],
             ["`receipts:confirm`", "Confirm cash received at the counter"],
             ["`reconciliation:approve`", "Approve a cash count somebody else performed"],
             ["`savings:approve_withdrawal`", "Decide a member's withdrawal request"],
             ["`benefits:approve`, `benefits:pay`", "Decide and pay a welfare claim"],
             ["`fines:assess`", "Assess meeting attendance fines"],
             ["`penalties:view`, `delinquency:view`", "See the arrears and penalty registers"],
             ["`reports:view_financial`", "Read the financial report family"],
             ["`capital:record`", "Record capital introduced — an Owner still verifies it"],
         ],
         T.next("The Manager's additional capabilities over a Secretary / Treasurer.")))

    add(("h2", "3.2  The Manager's day"))
    add(("steps", [
        ("Sign in; read the dashboard.",
         "Arrears, expected-versus-collected and anything awaiting a decision."),
        ("Open **Agency ▸ Pending verification**.",
         "Each counter transaction shows who recorded it, the provider, the service, the "
         "principal, the customer reference and the commission. Verify or return each one."),
        ("Open **Collections ▸ Overdue** and work the list.",
         "Who is behind, by how much, and for how long."),
        ("Open **Loan Management ▸ Pending Approval**.",
         "Read the application, the guarantors and the security before deciding."),
        ("Decide anything in **Finance ▸ Transfers** and **Finance ▸ Expenses**.",
         "Both are two-person controls; you are the second person."),
        ("Approve yesterday's **Finance ▸ Reconciliation** counts.",
         "You cannot approve one you performed."),
        ("Before closing, check **Agency ▸ End-of-day exceptions**.",
         "Anything recorded but not posted, any variance not written off, any commission that "
         "did not match the agreed rate."),
    ]))
    add(("figures2", D("12-Agency", "agency-pending", "manager"), D("09-Collections", "overdue", "manager"),
         F.next("Pending verification and the Overdue register (desktop, Manager)"),
         "Left: the queue of counter transactions waiting for a second person. Right: every loan "
         "behind on its schedule, with how far behind."))

    add(("h2", "3.3  Verifying a counter transaction"))
    add(("p",
         "This is the single most frequent thing a Manager does, so it is worth describing in "
         "full. A counter transaction moves through four states:"))
    add(("code",
         "draft  ──submit──▶  awaiting_verification  ──verify──▶  posted  ──reverse──▶  reversed\n"
         "  │\n"
         "  └──cancel──▶  cancelled      (no journal entry is ever written)"))
    add(("p",
         "Nothing reaches the books until **posted**. A transaction sitting in "
         "*awaiting verification* has moved no cash and no float in the ledger, however real the "
         "notes on the counter are. That is why the end-of-day exception list matters."))
    add(("steps", [
        ("Open **Agency ▸ Pending verification**.",
         "Desktop: the Agency module in the rail. Mobile: menu ▸ Agency ▸ Pending verification."),
        ("Open the transaction.",
         "You see the provider, the service, the principal, the customer's identifier, the "
         "provider reference, the commission and who recorded it."),
        ("Check the provider reference against the provider's own confirmation.",
         "This is the only external evidence the transaction happened."),
        ("Press **Verify**.",
         "The journal entry is written: cash and float move, and the commission is recognised. "
         "The transaction becomes *posted*."),
        ("If something is wrong, press **Return** instead and say why.",
         "It goes back to the person who recorded it, with your reason attached."),
    ]))
    add(("figure", D("12-Agency", "agency-transaction-awaiting", "manager"),
         F.next("A counter transaction awaiting verification (desktop, Manager)"),
         "Everything the verifier needs is on one screen, including the person who recorded it — "
         "which is also the person POLYTOS will refuse to let verify it."))
    add(("callout", "warning", "Verifying is not a formality",
         "Pressing Verify is what moves the money in the books. If the provider reference is "
         "wrong, the float figure POLYTOS reports will drift away from the provider's own "
         "statement, and the drift will only surface at the next float reconciliation — by which "
         "time the customer has gone."))

    add(("h2", "3.4  What a Manager cannot do"))
    add(("bullets", [
        "**Create or disable staff accounts, or grant roles.** That is the Owner's.",
        "**Read the audit trail.** `audit:view` is Owner-only.",
        "**Verify capital.** A Manager may record it; only an Owner may verify it.",
        "**Disburse a loan.** A Manager approves; an Owner pays out.",
        "**Reverse a repayment.** `payments:reverse` is Owner-only.",
        "**Register a provider or an agent line, or approve a provider's terms.**",
        "**Authorise a commission exception or write off a variance.**",
        "**Reverse an agency transaction posted on an earlier day.**",
    ]))

    # =======================================================================
    # CHAPTER 4 — SECRETARY / TREASURER
    # =======================================================================
    F.chapter_is(4); T.chapter_is(4)
    add(("chapter", 4, "The Secretary / Treasurer",
         "The counter role: 54 capabilities. This is the cashier, the teller, the front office "
         "and the record keeper. If money changes hands with a customer, this is usually the "
         "person holding it."))

    add(("lead",
         "POLYTOS has no separate *Cashier* or *Teller* role. The Secretary / Treasurer is that "
         "role, and this chapter is the cashier's chapter: starting balances, recording "
         "transactions, handling the errors the screens give you, and ending the day "
         "accountable for the till."))

    add(("h2", "4.1  What the counter may do"))
    add(("table", ["Area", "What you may do", "What you may **not**"],
         [
             ["Clients", "Open the register, **update** an existing client, read remarks",
              "**Register a new client**, upload their documents, add a remark, change their "
              "status, or see the national identification number"],
             ["Guarantors", "Open the register and read it",
              "**Register**, update, link or release a guarantor"],
             ["Membership", "Open the register and read it",
              "**Enrol** a member, update one, or change a status"],
             ["Member savings", "Take deposits, prepare a withdrawal request, read an account",
              "Decide a withdrawal, post one, reverse a transaction, or read savings reports"],
             ["Member lending", "See who qualifies and what they have borrowed",
              "Create a member loan application"],
             ["Loans", "Prepare an application, edit a draft, submit it, attach documents",
              "Approve, cancel or disburse"],
             ["Collections", "Record a repayment and issue the receipt", "Reverse a payment"],
             ["Agency", "Record counter transactions, move float between tills, read agency reports",
              "Verify, reverse, correct, settle, reconcile or configure"],
             ["Finance", "Read the cash position and the general ledger; record a transfer, an "
              "expense, other income or a bank deposit; perform a cash count",
              "**Approve** any of them, confirm a deposit, or read financial reports"],
             ["Benefits", "Record a claim, manage beneficiaries", "Verify a beneficiary; assess, "
              "approve or pay a claim"],
             ["Meetings", "Convene a meeting, mark the register, collect fines",
              "Review an excuse, assess a fine, or reverse one"],
             ["Debt & security", "Record a recovery action, manage collateral", "Release a guarantee"],
         ],
         T.next("The Secretary / Treasurer's boundaries, area by area. This role holds 54 of the "
                "130 capabilities; the complete list is in "
                "`05-Verification/ROLE_PERMISSION_MATRIX.md`.")))
    add(("callout", "note", "Recording is not approving — and registering is not updating",
         "Two patterns run through the table above. First, the counter **records** financial "
         "documents and somebody senior **approves** them: a transfer, an expense, a bank "
         "deposit and a cash count are all recorded here and decided elsewhere. Second, the "
         "counter may **update** a client it did not create: registering a new client, a new "
         "guarantor or a new member is a Manager's act in this release."))

    add(("h2", "4.2  Starting the day: know your balances before you trade"))
    add(("p",
         "Before the first customer, open **Finance ▸ Cash Position**. It shows, for your "
         "branch, the cash at hand, the business's own MTN and Airtel wallets, the bank account, "
         "and the agency float held on each till."))
    add(("figure", D("11-Finance", "finance-cash-position", "manager"),
         F.next("The cash position before the counter opens (desktop)"),
         "Read three numbers before you start: **cash at hand** (can you pay a withdrawal?), "
         "**float on each till** (can you serve a deposit?), and whether any till is flagged as "
         "low. A float that runs out mid-queue is the most common avoidable problem at the "
         "counter."))
    add(("callout", "money", "Which way do cash and float move?",
         "A customer **deposit** gives you notes and spends your float: cash **up**, float "
         "**down**. A customer **withdrawal** takes notes from you and refills your float: cash "
         "**down**, float **up**. They always move in opposite directions, and by the same "
         "amount — the commission is separate and is not part of either."))

    add(("h2", "4.3  Recording a counter transaction"))
    add(("p",
         "Desktop: **Agency ▸ Agent Banking ▸ Record transaction**, or the large *Record "
         "transaction* button on the Agency hub. Mobile: menu ▸ Agency ▸ Record transaction."))
    add(("figure", D("12-Agency", "agency-record", "secretary"),
         F.next("The Record transaction screen (desktop, Secretary / Treasurer)"),
         "You choose the provider, then the service, then the till. The till list only shows "
         "tills you are authorised on — if the one you want is missing, you have not been "
         "assigned to it (see Manual Two, Chapter 4)."))
    add(("figure", M("12-Agency", "agency-record", "secretary"),
         F.next("The same screen on a phone"),
         "The fields are in the same order; the screen simply runs down the page. On a phone the "
         "provider and service pickers open the phone's own list control."))
    add(("h3", "What each field is"))
    add(("kv", [
        ("Provider", "Who the transaction is with — MTN, Airtel, a partner bank, a utility."),
        ("Service", "What kind of transaction. Each service has its own direction (deposit, "
                    "withdrawal or payment) and its own limits."),
        ("Till", "Which registered counter position is trading. This decides which float "
                 "account moves."),
        ("Principal amount", "The amount the **customer** is moving. Not the commission, and "
                             "not the fee."),
        ("Customer identifier", "The wallet number, account number or meter number. This is "
                                "what the provider's own record will be searched by."),
        ("Customer name", "Required by some services, optional on others."),
        ("Provider reference", "The confirmation code the provider's own system produced. For "
                               "most services this must be present before the transaction can be "
                               "submitted."),
        ("Customer fee", "What the customer paid you, where the service charges one."),
        ("Commission", "What the provider owes you. Usually computed for you from the agreed "
                       "rate; typing a different figure raises a commission exception that only "
                       "an Owner can authorise."),
    ]))
    add(("steps", [
        ("Choose the provider, the service and the till.",
         "The float available on that till is shown."),
        ("Enter the principal the customer is moving.",
         "If it is above the service's single-transaction limit the form refuses it."),
        ("Enter the customer identifier, and the name if the service asks for one.", ""),
        ("Complete the transaction on the provider's own handset or terminal.",
         "You now have a confirmation code."),
        ("Type that code into **Provider reference**.", ""),
        ("Press **Record**, then **Submit**.",
         "The transaction becomes *awaiting verification*. **No money has moved in the books "
         "yet.**"),
        ("Ask a Manager or Owner to verify it.",
         "On verification the journal posts and the balances change."),
    ]))
    add(("callout", "warning", "Two things that are not the same",
         "The money has left your till the moment you hand the customer their notes. It has not "
         "left your **books** until a second person verifies the record. If you go home with "
         "transactions still in *awaiting verification*, the figures POLYTOS reports for your "
         "branch are wrong by exactly that amount — and the end-of-day exception list will say "
         "so."))

    add(("h2", "4.4  Recording a loan repayment"))
    add(("p", "Desktop: **Collections ▸ Record a payment**. Mobile: menu ▸ Collections ▸ Record "
              "a payment."))
    add(("figures2", D("09-Collections", "payments-new", "secretary"),
         D("09-Collections", "payments-register", "secretary"),
         F.next("Recording a repayment, and the payment register (desktop)"),
         "You choose the loan, the amount, the method (cash, MTN, Airtel or bank) and the date. "
         "POLYTOS allocates the money across penalties, interest and principal by its own rules "
         "— you do not split it yourself — and issues a numbered receipt."))
    add(("callout", "control", "A repayment cannot be edited",
         "Payments are immutable. If one is wrong, an Owner reverses it and a correct one is "
         "recorded; both stay on the record. This is why the receipt number matters — it is how "
         "the reversal is tied to the original."))

    add(("h2", "4.5  Taking a savings deposit"))
    add(("p",
         "Open **Member Savings ▸ Savings Register**, find the member, open the account and "
         "choose **Deposit**. There is deliberately no *record a deposit* entry in the rail: a "
         "deposit is always to a particular member's account, so you start from the member."))
    add(("figures2", D("04-Savings", "savings-register", "secretary"),
         D("04-Savings", "savings-deposit", "secretary"),
         F.next("The savings register and the deposit screen (desktop)"),
         "A deposit increases the member's balance and increases the branch's cash at hand. "
         "Member savings sit in account `2100` — they are money POLYTOS owes its members, not "
         "income."))

    add(("h2", "4.6  When the screen refuses you"))
    add(("table", ["Message you see", "What it means", "What to do"],
         [
             ["*insufficient agency float*",
              "The till does not hold enough electronic value for this deposit",
              "Ask for a float top-up, or move float from another till"],
             ["*insufficient cash*",
              "The branch cash at hand will not cover this payout",
              "Bank less, or wait for collections; do not pay out"],
             ["*… is still provisional*",
              "The provider's commercial terms have not been approved",
              "Only an Owner can approve them; you cannot trade that provider yet"],
             ["The till you want is not in the list",
              "You are not authorised on it",
              "Ask an Owner to add you (Account authorisations)"],
             ["*Not authorized to …*",
              "Your role does not hold the capability",
              "This is correct behaviour; ask the role that does"],
             ["A duplicate reference is refused",
              "That provider reference has already been recorded",
              "Check the transaction history before recording it again"],
             ["The amount is above the limit",
              "The service has a single-transaction maximum",
              "Split it, or ask an Owner to review the limit"],
         ],
         T.next("The refusals a counter sees most often, and what to do about each.")))

    add(("h2", "4.7  Ending the day"))
    add(("steps", [
        ("Open **Agency ▸ Transaction history** filtered to today.",
         "Confirm nothing is still in *draft* or *awaiting verification*."),
        ("Count the physical cash in the till.", ""),
        ("Open **Finance ▸ Reconciliation ▸ New** and record the count.",
         "POLYTOS shows its own figure beside yours and computes the difference."),
        ("Explain any difference in the note.",
         "A difference with no explanation is what an approver will send back."),
        ("Submit it.",
         "A **different** Manager or Owner approves it. You cannot approve your own count."),
        ("Bank surplus cash if your branch does so.",
         "**Finance ▸ Bank Deposits** records it; a Manager or Owner confirms it arrived."),
        ("Sign out.", ""),
    ]))
    add(("figures2", D("11-Finance", "finance-reconciliation-new", "manager"),
         D("11-Finance", "finance-deposits", "owner"),
         F.next("Recording a cash count, and the bank deposit register (desktop)"),
         "The count is a document, not a correction: recording that the till is short does not "
         "move the shortfall anywhere. Writing it off is a separate, Owner-only decision."))

    # =======================================================================
    # CHAPTER 5 — CLIENT
    # =======================================================================
    F.chapter_is(5); T.chapter_is(5)
    add(("chapter", 5, "The Client (borrower portal)",
         "The only non-staff role. Three capabilities, one screen, and nothing that can change a "
         "figure."))

    add(("lead",
         "A borrower whose account has been linked can sign in and see their own loans, their "
         "schedule and their payment history. They can see nothing else, and they can change "
         "nothing at all."))

    add(("h2", "5.1  What the Client role holds"))
    add(("table", ["Capability", "What it allows"],
         [["`portal:view`", "Open the client portal"],
          ["`account:view`", "See their own account details"],
          ["`account:update`", "Change their own password"]],
         T.next("The Client role in full — three capabilities.")))

    add(("figures2", D("17-Portal", "portal-home", "borrower"), M("17-Portal", "portal-home", "borrower"),
         F.next("The client portal (desktop and mobile)"),
         "The portal shows the borrower's own loans with the balance outstanding, the repayment "
         "schedule and the payments received. There is no rail, no other module, and no control "
         "that writes anything."))

    add(("h2", "5.2  Linking a borrower to a portal account"))
    add(("p",
         "A client record and a portal sign-in are two different things. Creating a client does "
         "not create a sign-in. A staff member holding `clients:link_auth` links the two, and "
         "only then can the borrower sign in. Until that happens the borrower simply has no "
         "account."))
    add(("callout", "note", "Why the portal shows so little",
         "Row Level Security restricts a Client to rows that belong to them. It is not that the "
         "portal chooses to display less — a borrower's session cannot read another borrower's "
         "loan at all, by any route."))

    # =======================================================================
    # CHAPTER 6 — ROLES COMPARED
    # =======================================================================
    F.chapter_is(6); T.chapter_is(6)
    add(("chapter", 6, "The four roles compared",
         "One table per decision you are likely to need to look up: who may do this?"))

    add(("p",
         "POLYTOS implements four roles and no more. If your organisation's job titles do not "
         "match them — if you have an *Accountant*, a *Teller* or an *Internal Auditor* — those "
         "people are given whichever of the four roles carries the capabilities their job needs. "
         "The complete capability-by-capability matrix is published as "
         "`05-Verification/ROLE_PERMISSION_MATRIX.md` alongside this manual; the tables below "
         "are the parts a user needs day to day."))

    add(("h2", "6.1  Money movements"))
    add(("table", ["Action", "Client", "Secretary / Treasurer", "Manager", "Owner / Administrator"],
         [
             ["Record a loan repayment", "", "Yes", "Yes", "Yes"],
             ["Reverse a loan repayment", "", "", "", "Yes"],
             ["Take a savings deposit", "", "Yes", "Yes", "Yes"],
             ["Request a savings withdrawal", "", "Yes", "Yes", "Yes"],
             ["Decide a savings withdrawal", "", "", "Yes", "Yes"],
             ["Record an agency transaction", "", "Yes", "Yes", "Yes"],
             ["Verify an agency transaction", "", "", "Yes", "Yes"],
             ["Reverse an agency transaction (same day)", "", "", "Yes", "Yes"],
             ["Reverse one from an earlier day", "", "", "", "Yes"],
             ["Move float between tills", "", "Yes", "Yes", "Yes"],
             ["Top up float from cash or bank", "", "", "Yes", "Yes"],
             ["Record a transfer between accounts", "", "Yes", "Yes", "Yes"],
             ["Approve a transfer", "", "", "Yes", "Yes"],
             ["Record an expense", "", "Yes", "Yes", "Yes"],
             ["Approve an expense", "", "", "Yes", "Yes"],
             ["Record capital introduced", "", "", "Yes", "Yes"],
             ["Verify capital introduced", "", "", "", "Yes"],
             ["Bank cash", "", "Yes", "Yes", "Yes"],
             ["Confirm cash reached the bank", "", "", "Yes", "Yes"],
         ],
         T.next("Who may move money, and who may approve the movement.")))

    add(("h2", "6.2  Lending"))
    add(("table", ["Action", "Client", "Secretary / Treasurer", "Manager", "Owner / Administrator"],
         [
             ["See the loan register", "", "Yes", "Yes", "Yes"],
             ["See their own loans only", "Yes", "", "", ""],
             ["Register a new client", "", "", "Yes", "Yes"],
             ["Update an existing client", "", "Yes", "Yes", "Yes"],
             ["Register a guarantor", "", "", "Yes", "Yes"],
             ["Link a guarantor to a loan", "", "", "Yes", "Yes"],
             ["Prepare a loan application", "", "Yes", "Yes", "Yes"],
             ["Submit an application for decision", "", "Yes", "Yes", "Yes"],
             ["Approve or reject an application", "", "", "Yes", "Yes"],
             ["Cancel an application", "", "", "Yes", "Yes"],
             ["Disburse an approved loan", "", "", "", "Yes"],
             ["See arrears and penalties", "", "Yes", "Yes", "Yes"],
             ["Record a recovery action", "", "Yes", "Yes", "Yes"],
             ["Release a guarantee", "", "", "Yes", "Yes"],
             ["Enrol a member", "", "", "Yes", "Yes"],
         ],
         T.next("Who may do what in the lending workflow.")))

    add(("h2", "6.3  Configuration and oversight"))
    add(("table", ["Action", "Client", "Secretary / Treasurer", "Manager", "Owner / Administrator"],
         [
             ["Register a staff account", "", "", "", "Yes"],
             ["Grant or remove a role", "", "", "", "Yes"],
             ["Suspend a staff account", "", "", "", "Yes"],
             ["Issue a temporary password", "", "", "", "Yes"],
             ["Change company or lending settings", "", "", "", "Yes"],
             ["Create a loan product", "", "", "", "Yes"],
             ["Register an agency provider", "", "", "", "Yes"],
             ["Approve a provider's terms", "", "", "", "Yes"],
             ["Register an agent line", "", "", "", "Yes"],
             ["Authorise staff on a till", "", "", "Yes", "Yes"],
             ["Read the general ledger", "", "Yes", "Yes", "Yes"],
             ["Read the trial balance", "", "Yes", "Yes", "Yes"],
             ["Read financial reports", "", "", "Yes", "Yes"],
             ["Read the audit trail", "", "", "", "Yes"],
         ],
         T.next("Who may configure the system and who may inspect it.")))

    add(("callout", "note", "There is no read-only auditor role",
         "Oversight in POLYTOS is the `audit:view` capability, and it belongs to the Owner / "
         "Administrator alone. An external auditor is given an Owner / Administrator account, "
         "which also grants the ability to change things. If your organisation needs a genuinely "
         "read-only oversight account, that role does not exist in this release — it is recorded "
         "as finding F-06 in the findings report."))

    # =======================================================================
    # CHAPTER 7 — HOW A SCREEN IS DOCUMENTED
    # =======================================================================
    F.chapter_is(7); T.chapter_is(7)
    add(("chapter", 7, "How to read the module chapters",
         "Every module chapter that follows uses the same ten headings, in the same order."))
    add(("kv", [
        ("Purpose", "What the module is for, in one or two sentences."),
        ("Available to", "The roles that can open it at all."),
        ("Prerequisites", "What must already be configured before it will work."),
        ("How to access", "The navigation path, on desktop and on a phone."),
        ("The screen", "A real screenshot, with the controls explained beneath it."),
        ("Fields explained", "Every field you have to understand in order to fill it in."),
        ("Step by step", "Numbered actions, each with what you should see afterwards."),
        ("Worked example", "A real transaction from the demonstration organisation, with the "
                           "balances before and after."),
        ("Verification", "How to prove to yourself that it worked."),
        ("Common errors and precautions", "What goes wrong, what POLYTOS says, and what it costs."),
    ]))
    add(("p",
         "Where a workflow has an approval stage, the chapter follows it to the end — recording, "
         "approving, posting and, where it applies, reversing. A chapter never stops at the "
         "data-entry screen."))

    return B
