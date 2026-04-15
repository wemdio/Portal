-- Bot known Telegram chats — stores chats where Atmos bot is a member
-- Applied to PolzaInstantlyDB (pwcidzaqudfkodgmesyk)
CREATE TABLE IF NOT EXISTS bot_known_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL UNIQUE,
  chat_title text,
  chat_type text DEFAULT 'group',
  added_by uuid,
  created_at timestamptz DEFAULT now()
);

-- Make client_user_id optional in client_forwarded_leads
ALTER TABLE client_forwarded_leads ALTER COLUMN client_user_id DROP NOT NULL;
