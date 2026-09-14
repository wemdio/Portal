# Ownership when another employee replies

## Incident and fix

A message sent to a company's general mailbox can be answered by an employee
from another address and assigned a different Instantly thread token.
Searching only the reply sender then finds no actual outbound parent, even
when that parent exists and is quoted in the reply.

The ownership resolver now also searches original To recipients from coherent
quoted From/Date/To/Subject blocks (English and Russian), provided From names
our exact receiving mailbox. These addresses are lookup hints, not routing
authority. Signature addresses and same-domain guesses are not used.

To admit a changed-address parent, the actual provider outbound must have:

- a candidate campaign from the existing exact mailbox mapping;
- our exact mailbox in both eaccount and From;
- a To recipient from that quoted block;
- a matching subject (ignoring reply/forward prefixes);
- a substantial quoted body match (at least 160 normalized characters);
- an actual send timestamp preceding the inbound.

Existing cross-owner ambiguity checks remain in force. Identical matches in
different projects do not authorize choosing one. All searched identities must
finish both search and sent pagination before a cross-owner result is used.
At most four distinct identities are considered; overflow fails closed.

The existing Others trusted-parent path is checked before expanding these
lookup hints. It still validates the prefetched outbound against the candidate
campaigns, exact mailbox and existing chronology rules; a trust flag alone
does not suffice. A validated parent needs no additional provider searches,
even if the quoted header has many recipients. Unproven overflow still defers.

Recovery saves progress separately for each identity under evidence version 2,
so previous negative searches cannot hide the newly searched recipient.
The 45-second recovery evidence budget is shared across the identities;
the existing shared Instantly read limiter still governs every request.

## Verification and release boundary

Verified offline with the actual GenieMap inbound and its Sep8 provider parent:
the resolver finds the correct parent and project despite different addresses
and thread tokens. A temporary local harness also checked English/Russian,
HTML/CRLF, wrong mailbox/recipient/subject/body/date, cross-project ties,
ordinary replies and resuming after local quota deferral.

No production classification, notification or ownership data was rewritten.
No migration is required. Deployment is required for production recovery to
use the new code; provider billing and other ownership failure modes remain
separate issues. This change is not a universal 24-hour completion guarantee.
