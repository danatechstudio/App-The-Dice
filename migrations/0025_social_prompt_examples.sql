-- Example posts beside each social prompt (.superpowers/sdd/2026-10-23-example-posts/brief.md). For each
-- prompt version that is approved or needs review, n8n has Gemini write one sample Facebook post the way
-- the live posting flow would (the prompt's layer, Michelle's Standard Prompt, the next real date), and
-- the app runs it through the same check as a live event post. It is kept here, beside the version, so
-- admins can see what the prompt writes. An example never changes the version's status, never posts,
-- is never written to the sheet and adds no social_checks row. Additive: seven columns, all empty.
-- It is applied to production only with the owner's go-ahead, after 0024.

ALTER TABLE social_prompts ADD COLUMN example_post TEXT;                          -- the sample post, trimmed (up to 5,000 characters)
ALTER TABLE social_prompts ADD COLUMN example_check TEXT;                         -- JSON { passed, problems }: the post check's verdict on it
ALTER TABLE social_prompts ADD COLUMN example_model TEXT;
ALTER TABLE social_prompts ADD COLUMN example_job_id TEXT;                        -- the n8n execution id
ALTER TABLE social_prompts ADD COLUMN example_generated_at TEXT;
ALTER TABLE social_prompts ADD COLUMN example_attempts INTEGER NOT NULL DEFAULT 0; -- answers so far, examples and failures; n8n stops asking after 3
ALTER TABLE social_prompts ADD COLUMN example_error TEXT;                         -- what n8n said when it last couldn't write one
