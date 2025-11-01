-- wallets 테이블에 address 인덱스 추가
-- webhook에서 from/to 주소로 빈번하게 조회하므로 성능 개선을 위해 인덱스 생성

CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);

-- address는 대소문자를 구분하지 않는 경우가 많으므로 lower 인덱스도 추가
CREATE INDEX IF NOT EXISTS idx_wallets_address_lower ON wallets(LOWER(address));

-- user_id 인덱스도 추가 (조인 성능 개선)
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);