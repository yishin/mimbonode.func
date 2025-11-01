-- webhook_log 테이블 생성
CREATE TABLE IF NOT EXISTS webhook_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    webhook_type VARCHAR(100),
    event_type VARCHAR(100),
    contract_address VARCHAR(255),
    from_address VARCHAR(255),
    to_address VARCHAR(255),
    token_symbol VARCHAR(50),
    token_amount NUMERIC,
    transaction_hash VARCHAR(255),
    block_number BIGINT,
    block_timestamp TIMESTAMPTZ,
    raw_data JSONB,
    processed BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB
);

-- 인덱스 추가
CREATE INDEX IF NOT EXISTS idx_webhook_log_transaction_hash ON webhook_log(transaction_hash);
CREATE INDEX IF NOT EXISTS idx_webhook_log_from_address ON webhook_log(from_address);
CREATE INDEX IF NOT EXISTS idx_webhook_log_to_address ON webhook_log(to_address);
CREATE INDEX IF NOT EXISTS idx_webhook_log_created_at ON webhook_log(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_log_processed ON webhook_log(processed);
CREATE INDEX IF NOT EXISTS idx_webhook_log_event_type ON webhook_log(event_type);

-- RLS 활성화
ALTER TABLE webhook_log ENABLE ROW LEVEL SECURITY;

-- RLS 정책 추가 (서비스 역할 및 관리자 접근 가능)
CREATE POLICY "Service role can manage webhook logs" ON webhook_log
    FOR ALL
    USING (auth.role() = 'service_role');

CREATE POLICY "Admin users can view webhook logs" ON webhook_log
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.user_id = auth.uid()
            AND profiles.user_role = 'admin'
        )
    );