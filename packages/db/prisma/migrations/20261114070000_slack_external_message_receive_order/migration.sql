BEGIN;
SET LOCAL lock_timeout = '10s';

-- Existing rows retain their historical event-time order. Setting the
-- default separately leaves them NULL and avoids rewriting the table.
CREATE SEQUENCE public.external_message_receive_seq AS bigint;
ALTER TABLE public.external_messages ADD COLUMN "receiveSeq" bigint;
ALTER SEQUENCE public.external_message_receive_seq OWNED BY public.external_messages."receiveSeq";
ALTER TABLE public.external_messages ALTER COLUMN "receiveSeq"
  SET DEFAULT nextval('public.external_message_receive_seq'::regclass);

COMMIT;
