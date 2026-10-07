ALTER TABLE catalogue_sources ADD COLUMN content_hash TEXT;
CREATE INDEX idx_email_verifications_expires_at ON email_verifications(expires_at);
