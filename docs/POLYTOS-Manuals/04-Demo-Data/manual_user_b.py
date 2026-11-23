"""
POLYTOS Complete User & Operations Manual — Part B.

Chapters 8 onwards: every implemented module, in the ten-heading format
Chapter 7 sets out.
"""

from content_common import D, GLOSSARY, M, Figures, Tables, ugx

F = Figures()
T = Tables()


def _module(add, *, name, purpose, roles, prereq, desktop_path, mobile_path):
    add(("h3", "Purpose"))
    add(("p", purpose))
    add(("h3", "Available to"))
    add(("bullets", roles))
    add(("h3", "Prerequisites"))
    add(("bullets", prereq))
    add(("h3", "How to access"))
    add(("table", ["Device", "Path"],
         [["Desktop", desktop_path], ["Mobile", mobile_path]], None))


def blocks():
    B = []
    add = B.append

    # =======================================================================
    # CHAPTER 8 — DASHBOARDS
    # =======================================================================
    F.chapter_is(8); T.chapter_is(8)
    add(("chapter", 8, "Dashboards",
         "What each figure on the home screen means, where it comes from, and what to do when "
         "one of them looks wrong."))

    add(("h2", "8.1  The staff dashboard"))
    _module(add,
            name="Dashboard",
            purpose="A single page of the figures that decide what the day looks like: what has "
                    "been lent, what has been collected, what is due today, what is behind, and "
                    "what is waiting for a decision.",
            roles=["Secretary / Treasurer", "Manager", "Owner / Administrator"],
            prereq=["`dashboard:view`, which all three staff roles hold.",
                    "Nothing else — an empty system shows zeros rather than an error."],
            desktop_path="The first entry in the left rail, pinned above the modules.",
            mobile_path="Menu ▸ Dashboard. It is also where signing in lands you.")
    add(("figure", D("01-Access", "dashboard", "owner"),
         F.next("The staff dashboard (desktop, Owner / Administrator)"),
         "The top of the page. It continues below the fold with the loan book by status, "
         "late-payment charges, portfolio at risk, member savings, promises and follow-ups, "
         "anything awaiting a decision, today's collections and the quick actions. The sections "
         "below work through all of it in order."))

    add(("h3", "Panel by panel"))
    add(("table", ["Panel", "What the figure is", "Where it comes from", "Who sees it"],
         [
             ["Business summary — Principal disbursed", "Total principal paid out to borrowers",
              "The disbursement postings", "All staff"],
             ["Business summary — Total collected", "All repayments received, reversals excluded",
              "The payment ledger", "All staff"],
             ["Business summary — Outstanding portfolio", "Principal still owed on live loans",
              "`Loans Receivable` (1200) plus charges", "All staff"],
             ["Charged against collected", "Interest and penalties charged, beside what was "
              "actually received", "The schedule and the payment allocations", "All staff"],
             ["Today", "Expected, collected and still due for today's business date",
              "The repayment schedule for the business day", "All staff"],
             ["Payments received today, by method", "Today's collections split into cash, MTN, "
              "Airtel and bank", "The payment method on each receipt", "All staff"],
             ["The loan book", "Active loans, cleared loans, outstanding portfolio, arrears",
              "The loan register", "All staff"],
             ["Disbursed loans by status", "Mutually exclusive counts that add to the number of "
              "disbursed loans", "The workflow stage of each loan", "All staff"],
             ["Late-payment charges", "Penalties charged, unpaid and pending",
              "The penalty register", "Manager, Owner"],
             ["Portfolio at risk", "PAR 30, over 90 days, and the live book",
              "The ageing calculation", "Manager, Owner"],
             ["Member savings", "What is owed to members, this month's minimum, withdrawals to "
              "decide", "`Member Savings` (2100)", "All staff"],
             ["Promises and follow-ups", "Promises due today, promises broken, overdue "
              "follow-ups", "The recovery register", "Manager, Owner"],
             ["Awaiting a decision", "Transfers, expenses and cash counts that need somebody",
              "The documents in a submitted state", "Manager, Owner"],
         ],
         T.next("Every dashboard panel, and the source of its figure.")))

    add(("callout", "note", "Does it update by itself?",
         "No. The dashboard is rendered when you open it, from the figures in the database at "
         "that moment. The refresh button in the top bar re-reads them. Nothing on the page "
         "polls, so a figure you are watching will not change until you ask for it again."))

    add(("h3", "When a figure looks wrong"))
    add(("numbers", [
        "**Check the business day in the top bar.** 'Today' means that date, not the date on "
        "your device.",
        "**Check the branch filter**, where the panel has one. A branch-scoped figure is not the "
        "whole organisation.",
        "**Open the register behind the panel.** Every card links to the list it was counted "
        "from — the arrears figure to the arrears register, the savings figure to the savings "
        "register.",
        "**Look for anything unverified.** A counter transaction in *awaiting verification* has "
        "moved nothing in the books, so cash and float figures will be behind the physical till "
        "by exactly that amount.",
        "**Read the trial balance.** If debits do not equal credits, stop and raise it: no "
        "ordinary operation can produce that.",
    ]))

    add(("h2", "8.2  The Agency hub"))
    add(("figures2", D("12-Agency", "agency-overview", "owner"), M("12-Agency", "agency-overview", "secretary"),
         F.next("The Agency hub (desktop as Owner, mobile as Secretary / Treasurer)"),
         "Three figures sit at the top: **commission outstanding** (earned, not yet remitted), "
         "**held on providers' behalf** (money that is not yours), and **electronic float held** "
         "across the tills. Below them, *Needs attention today* lists what will stop the day "
         "closing cleanly."))

    add(("h2", "8.3  The client portal"))
    add(("figure", D("17-Portal", "portal-home", "borrower"),
         F.next("What a borrower sees (desktop)"),
         "Their loans, the balance outstanding on each, the schedule and the payments received. "
         "No totals for the business, no other borrower, and nothing that can be changed."))

    # =======================================================================
    # CHAPTER 9 — CLIENTS AND GUARANTORS
    # =======================================================================
    F.chapter_is(9); T.chapter_is(9)
    add(("chapter", 9, "Clients and guarantors",
         "Registering the people the business lends to, and the people who stand behind them."))

    add(("h2", "9.1  The client register"))
    _module(add,
            name="Client register",
            purpose="Every borrower the business has taken on, with their identity documents, "
                    "status and history.",
            roles=["Secretary / Treasurer — open the register and **update** an existing client",
                   "Manager — all of that, plus **registering** a client, uploading documents, "
                   "adding remarks, changing status and seeing the identification number",
                   "Owner / Administrator — all of that, plus blacklisting and archiving"],
            prereq=["`clients:view` to open it, `clients:create` to add anybody — which the "
                    "Secretary / Treasurer does **not** hold.",
                    "Reference numbering configured — clients are numbered `CL26001` and upward."],
            desktop_path="Clients ▸ Client Register",
            mobile_path="Menu ▸ Clients ▸ Client Register")
    add(("figures2", D("02-Clients", "clients-register", "secretary"),
         M("02-Clients", "clients-register", "secretary"),
         F.next("The client register (desktop and mobile)"),
         "On a desktop the register is a table. On a phone each client becomes a card carrying "
         "the same fields. The status chips at the top — Active, Inactive, Suspended, "
         "Blacklisted — are filters on the same list, not different screens."))

    add(("h3", "Registering a client"))
    add(("figure", D("02-Clients", "clients-new", "secretary"),
         F.next("The new client form (desktop)"),
         "Required fields carry a red asterisk. The national identification number is stored but "
         "only shown to roles holding `clients:view_nin` — everybody else sees it masked."))
    add(("steps", [
        ("Open **Clients ▸ New Client**.", "The registration form opens, empty."),
        ("Enter the full name and telephone number.",
         "The number is checked for Ugandan shape; `0772…` and `+256772…` are both accepted."),
        ("Enter the national identification number and date of birth.",
         "The identification number must be unique — a duplicate is refused."),
        ("Choose the branch.", "The client belongs to that branch for reporting and access."),
        ("Upload the identity documents.", "They are stored privately, not in the public web root."),
        ("Press **Register**.",
         "A client number is minted (`CL26…`) and you land on the client's own page."),
    ]))
    add(("figure", D("02-Clients", "client-detail", "secretary"),
         F.next("A client's own page (desktop)"),
         "Everything about one person in one place: their details, their loans, their payments, "
         "their guarantees, their remarks and their documents."))
    add(("callout", "warning", "Blacklisting is not a tidy-up",
         "Blacklisting a client is an Owner-only act that blocks further lending to them and is "
         "recorded in the audit trail with the person who did it. It is not a way to hide a "
         "record you no longer want to see — use *Inactive* for that."))

    add(("h2", "9.2  Guarantors"))
    _module(add,
            name="Guarantors",
            purpose="The people who undertake to pay if a borrower does not, and the register of "
                    "which loans each of them stands behind.",
            roles=["Secretary / Treasurer — read the register only",
                   "Manager — register, update, link to a loan, upload documents, release a "
                   "guarantee, and see the identification number",
                   "Owner / Administrator — all of that"],
            prereq=["`guarantors:view` to read it; `guarantors:create` to add one, which the "
                    "Secretary / Treasurer does **not** hold.",
                    "Guarantor rules configured under Administration ▸ Guarantor Rules — in "
                    "particular the concentration ceiling, which limits how much one person may "
                    "guarantee."],
            desktop_path="Clients ▸ Guarantor Register",
            mobile_path="Menu ▸ Clients ▸ Guarantor Register")
    add(("figures2", D("02-Clients", "guarantors-register", "secretary"),
         D("02-Clients", "guarantors-new", "secretary"),
         F.next("The guarantor register and the registration form (desktop)"),
         "The register shows each guarantor's total exposure — the sum of what they stand behind "
         "— which is what the concentration ceiling is checked against."))
    add(("callout", "control", "The concentration ceiling",
         "POLYTOS refuses to link a guarantor to a further loan if doing so would take their "
         "total exposure above the ceiling in the guarantor rules. The refusal names the "
         "guarantor and the figure. This is a lending control, not a suggestion: raising the "
         "ceiling is an Owner decision made in Administration ▸ Guarantor Rules."))

    # =======================================================================
    # CHAPTER 10 — MEMBERSHIP
    # =======================================================================
    F.chapter_is(10); T.chapter_is(10)
    add(("chapter", 10, "Membership",
         "Enrolling members, the policy version they accepted, and the status history that "
         "follows them."))

    _module(add,
            name="Membership",
            purpose="The register of members — people who have joined the scheme, paid the "
                    "registration fee, accepted a published policy version, and may therefore "
                    "save, borrow against savings and claim welfare benefits.",
            roles=["Secretary / Treasurer — read the register only",
                   "Manager — enrol, update, record consent and the fee, and change a status",
                   "Owner / Administrator — all of that, plus publishing policy versions"],
            prereq=["`membership:view` to open the register; `membership:create` to enrol, which "
                    "the Secretary / Treasurer does **not** hold.",
                    "A **published membership policy version**. Without one there is nothing for "
                    "a member to accept, and enrolment cannot complete.",
                    "The registration fee set in the policy."],
            desktop_path="Membership ▸ Membership Register",
            mobile_path="Menu ▸ Membership ▸ Membership Register")
    add(("figures2", D("03-Membership", "membership-register", "secretary"),
         M("03-Membership", "membership-register", "secretary"),
         F.next("The membership register (desktop and mobile)")))
    add(("figure", D("03-Membership", "membership-enrol", "secretary"),
         F.next("Enrolling a member (desktop)"),
         "Enrolment ties three things together: the client record, the policy version being "
         "accepted, and the registration fee receipt. A membership is not active until all "
         "three exist."))
    add(("figure", D("03-Membership", "membership-policies", "owner"),
         F.next("The membership policy (desktop)"),
         "The published policy version, the registration fee, the savings minimum, and the "
         "benefit rules. Reading it is ordinary counter work; publishing a new version is an "
         "Owner-only act that the database refuses to anybody else."))
    add(("callout", "warning", "A known defect on the member's own page",
         "Opening a single membership — **Membership ▸ Membership Register ▸ (a member)** — "
         "fails for the Secretary / Treasurer with a server error. The page reads the benefit "
         "panel, which that role is not permitted to see, and the refusal is not handled, so the "
         "whole page fails rather than the one panel. Owners and Managers are unaffected. This "
         "is recorded as finding **F-02**; until it is fixed, a Secretary should work from the "
         "register and the savings screens, and ask a Manager to open a member's own page."))

    # =======================================================================
    # CHAPTER 11 — MEMBER SAVINGS
    # =======================================================================
    F.chapter_is(11); T.chapter_is(11)
    add(("chapter", 11, "Member savings",
         "Taking deposits, requesting withdrawals, and the two-person decision that releases "
         "money to a member."))

    _module(add,
            name="Member savings",
            purpose="Savings accounts belonging to members. Deposits increase what the business "
                    "owes its members; withdrawals release it, but only after somebody senior "
                    "has decided.",
            roles=["Secretary / Treasurer — take deposits, prepare a withdrawal request, read "
                   "an account and its statement",
                   "Manager — all of that, plus deciding a withdrawal, posting it, and the "
                   "savings reports",
                   "Owner / Administrator — all of that, plus reversing a savings transaction"],
            prereq=["`savings:view`; `savings:deposit` to take money in.",
                    "An **active membership**. A savings account belongs to a membership, not to "
                    "a client.",
                    "Cash at hand at the branch, for a withdrawal to be payable."],
            desktop_path="Member Savings ▸ Savings Register",
            mobile_path="Menu ▸ Member Savings ▸ Savings Register")
    add(("figures2", D("04-Savings", "savings-register", "secretary"),
         D("04-Savings", "savings-detail", "secretary"),
         F.next("The savings register and one account (desktop)")))

    add(("h3", "Taking a deposit"))
    add(("figure", D("04-Savings", "savings-deposit", "secretary"),
         F.next("The deposit screen (desktop)"),
         "You reach this from the member's account, not from the rail — a deposit is always to a "
         "particular account, so starting anywhere else would only open a chooser the register "
         "already is."))
    add(("steps", [
        ("Open **Member Savings ▸ Savings Register** and find the member.", ""),
        ("Open their account and press **Deposit**.", "The deposit form opens."),
        ("Enter the amount and the method.", "Cash, MTN, Airtel or bank."),
        ("Enter the external reference, if the method has one.", ""),
        ("Press **Record deposit**.",
         "A numbered receipt is issued, the member's balance rises, and the branch's cash (or "
         "wallet) rises by the same amount."),
    ]))
    add(("h4", "What it does to the books"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash at Hand — the branch", "`1010-BR…`", "the amount", ""],
          ["Member Savings", "`2100`", "", "the amount"]],
         T.next("A member's cash deposit of any amount. Savings are a liability: the money is "
                "the member's, held by the business.")))

    add(("h3", "A withdrawal, end to end"))
    add(("figures2", D("04-Savings", "savings-withdraw", "secretary"),
         D("04-Savings", "savings-withdrawals-queue", "manager"),
         F.next("Requesting a withdrawal, and the queue of requests awaiting a decision"),
         "The Secretary prepares the request; it appears in the Manager's queue. Preparing it "
         "moves nothing."))
    add(("steps", [
        ("The member asks to withdraw. The Secretary opens their account and presses "
         "**Withdraw**.", "A request is created. No money has moved."),
        ("A Manager or Owner opens **Member Savings ▸ Withdrawal Requests**.",
         "Every request waiting for a decision, with the member's balance and any outstanding "
         "member loan."),
        ("They approve or refuse it.",
         "POLYTOS refuses an approval that would take the balance below what an outstanding "
         "member loan is secured on."),
        ("The counter pays the member and posts the withdrawal.",
         "Member Savings falls, cash at hand falls."),
    ]))
    add(("callout", "control", "Why a withdrawal needs two people",
         "A savings withdrawal is the one routine operation that takes money out of the business "
         "and hands it to somebody. The person who prepares it may not be the person who decides "
         "it, and the decision is recorded with the name of whoever made it."))

    # =======================================================================
    # CHAPTER 12 — MEMBER LENDING
    # =======================================================================
    F.chapter_is(12); T.chapter_is(12)
    add(("chapter", 12, "Member lending",
         "Lending to members against what they have saved."))

    _module(add,
            name="Member lending",
            purpose="Loans to members, assessed against their savings balance rather than "
                    "against ordinary collateral. A member may borrow a multiple of what they "
                    "have saved, and the savings are pledged against the loan.",
            roles=["Secretary / Treasurer — see who qualifies and what they have borrowed",
                   "Manager and Owner — all of that, plus creating an application"],
            prereq=["`member_loans:view_eligibility` to see the registers; "
                    "`member_loans:create` to apply.",
                    "An active membership with a savings balance.",
                    "The member-lending rules configured: the multiplier, the interest basis, "
                    "the maximum term."],
            desktop_path="Member Lending ▸ Who Can Borrow / Member Loans",
            mobile_path="Menu ▸ Member Lending")
    add(("figures2", D("05-MemberLending", "member-loans-eligibility", "secretary"),
         D("05-MemberLending", "member-loans-new", "manager"),
         F.next("Who can borrow, and the member loan application (desktop)"),
         "*Who Can Borrow* answers the question a member asks at the counter — how much am I "
         "good for? — from their savings balance and the configured multiplier. The Secretary "
         "sees this register and not the application form, which is the only module in the "
         "system where one role sees part of another's screen set."))
    add(("callout", "note", "A member loan opens like any other loan",
         "There is deliberately no separate member-loan detail screen. A member loan opens at "
         "the ordinary loan page with a membership panel added, so there is one set of controls "
         "over one agreement rather than two."))

    # =======================================================================
    # CHAPTER 13 — MEMBER BENEFITS
    # =======================================================================
    F.chapter_is(13); T.chapter_is(13)
    add(("chapter", 13, "Member benefits",
         "Welfare claims: recording them, assessing them against the policy, approving them and "
         "paying them."))

    _module(add,
            name="Member benefits",
            purpose="The welfare side of membership — medical support, family condolence and "
                    "bereavement support — from the claim a member brings to the counter through "
                    "to the money going out.",
            roles=["Secretary / Treasurer — record a claim and manage beneficiaries",
                   "Manager — verify a beneficiary, assess a claim, approve it and pay it",
                   "Owner / Administrator — all of it"],
            prereq=["`benefits:view`; `benefits:claim` to record one.",
                    "A published policy carrying the benefit rules: the annual cap, the claims "
                    "per year, the waiting period and the year basis.",
                    "Registered and verified beneficiaries, for the benefits that pay to one."],
            desktop_path="Member Benefits ▸ Benefit Claims",
            mobile_path="Menu ▸ Member Benefits ▸ Benefit Claims")
    add(("figures2", D("06-Benefits", "benefits-overview", "secretary"),
         D("06-Benefits", "benefits-claims", "secretary"),
         F.next("The benefits overview and the claims register (desktop)")))
    add(("figure", D("06-Benefits", "benefits-claim-new", "secretary"),
         F.next("Recording a claim (desktop)"),
         "The claim records what happened, when it happened and what is being asked for. "
         "Assessment against the policy is a separate step done by somebody else."))
    add(("figures2", D("06-Benefits", "benefits-approvals", "manager"),
         D("06-Benefits", "benefits-payments", "owner"),
         F.next("The approvals queue and the payments screen (desktop)"),
         "Four states, four different pairs of hands: recorded, assessed, approved, paid. The "
         "assessment is what checks the annual cap and the waiting period; the approval is the "
         "decision; the payment is the money."))
    add(("h3", "Beneficiaries"))
    add(("figures2", D("06-Benefits", "beneficiaries", "secretary"),
         D("06-Benefits", "beneficiaries-new", "secretary"),
         F.next("The beneficiary register and registration form (desktop)"),
         "A beneficiary is registered by the counter and **verified** by somebody holding "
         "`beneficiaries:verify`. An unverified beneficiary cannot be paid."))

    # =======================================================================
    # CHAPTER 14 — MEETINGS
    # =======================================================================
    F.chapter_is(14); T.chapter_is(14)
    add(("chapter", 14, "Meetings and attendance fines",
         "Convening a members' meeting, marking the register, and the fines that follow an "
         "unexcused absence."))

    _module(add,
            name="Meetings",
            purpose="Members' meetings at a branch: convening them, recording who attended, "
                    "reviewing excuses, assessing fines on unexcused absences and collecting "
                    "them.",
            roles=["Secretary / Treasurer — convene, mark the register, collect fines",
                   "Manager — all of that, plus reviewing an excuse and assessing a fine",
                   "Owner / Administrator — all of it, plus reversing a fine"],
            prereq=["`meetings:view`, `meetings:manage` to convene one.",
                    "Live memberships at the branch — the register is the branch's own members.",
                    "The fine amount set in the policy."],
            desktop_path="Meetings ▸ Meetings",
            mobile_path="Menu ▸ Meetings")
    add(("figures2", D("07-Meetings", "meetings", "secretary"), D("07-Meetings", "meetings-new", "secretary"),
         F.next("The meetings register and convening a meeting (desktop)")))
    add(("figures2", D("07-Meetings", "meeting-detail", "secretary"),
         D("07-Meetings", "meeting-fines", "manager"),
         F.next("A meeting's attendance register, and the fines register (desktop)"),
         "Marking somebody absent does not fine them. A fine is assessed separately by a Manager, "
         "after any notice of absence has been reviewed — and only an Owner can reverse one."))

    # =======================================================================
    # CHAPTER 15 — LOAN MANAGEMENT
    # =======================================================================
    F.chapter_is(15); T.chapter_is(15)
    add(("chapter", 15, "Loan management",
         "The lending workflow from application to clearance, and the ten stages the register is "
         "organised around."))

    _module(add,
            name="Loan management",
            purpose="Every loan the business has made or been asked for, organised by where it "
                    "has reached in the workflow.",
            roles=["Secretary / Treasurer — prepare, edit and submit applications",
                   "Manager — approve, reject and cancel",
                   "Owner / Administrator — all of that, plus disbursement"],
            prereq=["`loans:view`; `loans:create` to prepare one.",
                    "A registered client, and the guarantors the product requires.",
                    "A configured **loan product** — the interest rate, the cadence and the term "
                    "come from it.",
                    "Cash at hand or a bank balance to disburse from."],
            desktop_path="Loan Management ▸ Loan Register",
            mobile_path="Menu ▸ Loan Management ▸ Loan Register")

    add(("h2", "15.1  The ten stages"))
    add(("p",
         "The rail carries one entry per stage. They are all the same register with a different "
         "filter, so no two of them can disagree about what 'in arrears' means."))
    add(("table", ["Stage", "What it holds", "Whose move is next"],
         [
             ["Draft", "An application being prepared", "The Secretary / Treasurer"],
             ["Pending approval", "Submitted, waiting for a decision", "A Manager or Owner"],
             ["Approved", "Decided in the borrower's favour", "An Owner, to disburse"],
             ["Awaiting disbursement", "Approved and queued for payment", "An Owner"],
             ["Active", "Disbursed and being repaid", "The borrower"],
             ["Grace period", "Past due but inside the grace window", "The borrower"],
             ["Arrears", "Past due and outside the grace window", "A Manager — recovery"],
             ["Cleared", "Fully repaid", "Nobody"],
             ["Rejected", "The decision went against the applicant", "Nobody"],
             ["Cancelled", "The applicant withdrew it", "Nobody"],
         ],
         T.next("The loan workflow stages and what each one is waiting for.")))
    add(("figures2", D("08-Loans", "loans-register", "manager"), M("08-Loans", "loans-register", "secretary"),
         F.next("The loan register (desktop and mobile)")))

    add(("h2", "15.2  Taking an application"))
    add(("figure", D("08-Loans", "loans-new", "secretary"),
         F.next("A new loan application (desktop)"),
         "Choosing the **product** fills in the interest rate, the repayment cadence and the "
         "permitted term. Those come from the product, not from the person taking the "
         "application, which is why a product has to be configured before any lending can start."))
    add(("steps", [
        ("Open **Loan Management ▸ New Loan Application**.", ""),
        ("Choose the client.", "Their existing loans and arrears are shown, so you can see "
                               "whether lending again is sensible."),
        ("Choose the product.", "The rate, cadence and term are filled in from it."),
        ("Enter the principal and the term.",
         "The form refuses anything outside the product's limits."),
        ("Add the guarantors the product requires.",
         "The concentration ceiling is checked as each one is linked."),
        ("Record the security or collateral, if any.", ""),
        ("Save it as a draft, then **Submit for approval**.",
         "It leaves your hands and appears in the Manager's queue."),
    ]))
    add(("figures2", D("08-Loans", "loan-detail-pending", "manager"),
         D("08-Loans", "loan-application", "manager"),
         F.next("A loan awaiting approval, and the application a Manager reads before deciding"),
         "The approval screen reads the **application**, not a summary of it — the terms the "
         "applicant agreed to are the terms being approved."))

    add(("h2", "15.3  Approval, disbursement and the schedule"))
    add(("callout", "control", "Approval and disbursement are two different acts",
         "A Manager approves; an Owner disburses. Approval commits the business to the "
         "agreement; disbursement moves the money. POLYTOS keeps them apart deliberately, and "
         "the stage list shows *Approved* and *Awaiting disbursement* as two separate places for "
         "the same reason."))
    add(("p",
         "Disbursement generates the **repayment schedule**, which is immutable from that moment: "
         "the instalments, their due dates and their split between principal and interest cannot "
         "be edited afterwards. A change of terms is a new agreement, not an edit."))
    add(("figures2", D("08-Loans", "loan-detail-active", "manager"),
         D("08-Loans", "loan-statement", "manager"),
         F.next("A live loan, and its statement (desktop)"),
         "The statement is what a borrower is given: every instalment, every payment, every "
         "charge, and the balance after each."))

    add(("h2", "15.4  Arrears, grace and penalties"))
    add(("figures2", D("08-Loans", "loans-arrears", "manager"), D("08-Loans", "loan-detail-arrears", "manager"),
         F.next("The arrears stage, and a loan inside it (desktop)")))
    add(("callout", "money", "Charging a penalty posts nothing",
         "POLYTOS keeps its books on a **cash basis**: income is recognised when it is collected, "
         "not when it is charged. A penalty therefore creates no journal entry at the moment it "
         "is applied. It reaches the books through the penalty component of the repayment that "
         "eventually settles it. This is why 'penalties charged' and 'penalty income' are "
         "different figures and are never equal."))

    # =======================================================================
    # CHAPTER 16 — COLLECTIONS
    # =======================================================================
    F.chapter_is(16); T.chapter_is(16)
    add(("chapter", 16, "Collections",
         "Recording repayments, how POLYTOS allocates them, and what happens when one is wrong."))

    _module(add,
            name="Collections",
            purpose="Money coming back from borrowers: recording it, allocating it across "
                    "penalties, interest and principal, issuing the receipt, and reversing it "
                    "where it was recorded in error.",
            roles=["Secretary / Treasurer — record a repayment and issue the receipt",
                   "Manager — all of that, plus the collection reports",
                   "Owner / Administrator — all of that, plus reversing a payment"],
            prereq=["`payments:view`; `payments:create` to record one.",
                    "A disbursed loan with a schedule."],
            desktop_path="Collections ▸ Record a payment",
            mobile_path="Menu ▸ Collections ▸ Record a payment")
    add(("figures2", D("09-Collections", "payments-new", "secretary"),
         M("09-Collections", "payments-new", "secretary"),
         F.next("Recording a repayment (desktop and mobile)")))

    add(("h3", "How the money is allocated"))
    add(("p",
         "You do **not** split the payment yourself. POLYTOS allocates it in a fixed order, and "
         "the receipt shows the result:"))
    add(("numbers", [
        "**Penalties** outstanding, oldest first.",
        "**Interest** due, oldest instalment first.",
        "**Principal** due, oldest instalment first.",
        "Anything left over reduces future principal.",
    ]))
    add(("h4", "What a repayment does to the books"))
    add(("table", ["Account", "Code", "Debit", "Credit"],
         [["Cash at Hand / MTN / Airtel / Bank", "`1010-BR…` etc.", "the amount received", ""],
          ["Loans Receivable", "`1200`", "", "the principal component"],
          ["Interest Income", "`4100`", "", "the interest component"],
          ["Penalty Income", "`4200`", "", "the penalty component"]],
         T.next("A repayment, on the cash basis POLYTOS keeps. The three credits add up to the "
                "one debit.")))
    add(("figures2", D("09-Collections", "payments-register", "secretary"),
         D("09-Collections", "payments-summary", "manager"),
         F.next("The payment register and the collection summary (desktop)")))
    add(("callout", "warning", "A payment cannot be edited",
         "Payments are immutable. A wrong one is **reversed** by an Owner and a correct one is "
         "recorded; both stay on the record and both appear on the borrower's statement. The "
         "receipt number is how the reversal is tied to the original, so never destroy a "
         "receipt."))
    add(("figure", D("09-Collections", "overdue", "manager"),
         F.next("The overdue register (desktop)"),
         "Who is behind, by how much, and for how long. This is the working list for a "
         "collections round."))

    # =======================================================================
    # CHAPTER 17 — DEBT AND SECURITY
    # =======================================================================
    F.chapter_is(17); T.chapter_is(17)
    add(("chapter", 17, "Debt and security",
         "Recovery actions, promises to pay, collateral and guarantee release."))

    _module(add,
            name="Debt & Security",
            purpose="What the business does about loans that have gone wrong: the recovery "
                    "actions taken, the promises borrowers have made, the collateral held and "
                    "the guarantees that can be released.",
            roles=["Manager — record recovery actions, release guarantees, manage collateral",
                   "Owner / Administrator — all of it"],
            prereq=["`recovery:view`; `recovery:record` to add an action.",
                    "`delinquency:view`, which the Secretary / Treasurer does not hold."],
            desktop_path="Debt & Security ▸ Recovery",
            mobile_path="Menu ▸ Debt & Security")
    add(("figures2", D("10-DebtSecurity", "recovery", "manager"),
         D("10-DebtSecurity", "recovery-promises", "manager"),
         F.next("The recovery register, and the promises view (desktop)"),
         "*Promise to Pay* is the same register filtered — a promise is a recovery action with a "
         "date attached, and the dashboard counts promises due today and promises broken from "
         "exactly these rows."))

    return B
