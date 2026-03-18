-- Remove generic info@ mailboxes from contact-level emails.
-- We keep person/direct mailboxes and only clear obvious info aliases.

update public.company_contacts
set channel_email = null
where channel_email ~* '^info([._+-].*)?@';

