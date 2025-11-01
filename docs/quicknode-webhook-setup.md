# QuickNode Webhook 설정 가이드

## 1. QuickNode 대시보드 접속
1. [QuickNode](https://www.quicknode.com) 로그인
2. 사용 중인 엔드포인트 선택

## 2. Streams (Webhook) 설정

### Stream 생성
1. 왼쪽 메뉴에서 **"Streams"** 클릭
2. **"Create Stream"** 버튼 클릭

### 기본 설정
- **Stream Name**: `MGG Token Transfer Monitor`
- **Network**: BSC Mainnet (또는 해당 네트워크)
- **Dataset**: `receipts` 또는 `logs`

### 필터 설정 (Event Filter)
```javascript
{
  "type": "log",
  "addresses": ["0xYOUR_MGG_TOKEN_CONTRACT_ADDRESS"],
  "topics": [
    ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  ]
}
```
- `0xddf252ad...`: Transfer(address,address,uint256) 이벤트 시그니처
- MGG 토큰 컨트랙트 주소로 교체 필요

### Webhook URL 설정
QuickNode는 Headers를 지원하지 않으므로 URL 토큰 방식을 사용합니다:

#### 옵션 1: 토큰 없이 사용 (개발/테스트)
```
https://YOUR_SUPABASE_PROJECT.supabase.co/functions/v1/webhook
```

#### 옵션 2: URL 토큰으로 보안 설정 (운영 환경 권장)
```
https://YOUR_SUPABASE_PROJECT.supabase.co/functions/v1/webhook?token=YOUR_SECRET_TOKEN
```

### 보안 설정 방법
1. **Supabase에서 토큰 설정:**
   - Supabase Dashboard > Edge Functions > 해당 함수 선택
   - Environment Variables에 `QUICKNODE_WEBHOOK_TOKEN` 추가
   - 값: 임의의 보안 토큰 (예: `qn_webhook_secret_2025`)

2. **QuickNode에서 URL 설정:**
   - Webhook URL 끝에 `?token=qn_webhook_secret_2025` 추가
   - 전체 URL 예시: `https://xyz.supabase.co/functions/v1/webhook?token=qn_webhook_secret_2025`

## 3. 고급 필터 옵션

### 특정 주소로의 전송만 모니터링
```javascript
{
  "type": "log",
  "addresses": ["0xMGG_TOKEN_ADDRESS"],
  "topics": [
    ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    null,  // from address (any)
    ["0xINTERNAL_USER_ADDRESS_1", "0xINTERNAL_USER_ADDRESS_2"]  // to addresses
  ]
}
```

## 4. Webhook Payload 예시
QuickNode에서 전송하는 데이터 구조:
```json
{
  "streamId": "stream_id",
  "chainId": "0x38",
  "blockNumber": "0x123456",
  "blockHash": "0xabc...",
  "blockTimestamp": "2025-11-01T00:00:00Z",
  "transactionHash": "0xdef...",
  "logs": [
    {
      "address": "0xMGG_TOKEN_ADDRESS",
      "topics": [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x000000000000000000000000FROM_ADDRESS",
        "0x000000000000000000000000TO_ADDRESS"
      ],
      "data": "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
      "blockNumber": "0x123456",
      "transactionHash": "0xdef...",
      "transactionIndex": "0x1",
      "blockHash": "0xabc...",
      "logIndex": "0x0",
      "removed": false
    }
  ]
}
```

## 5. 테스트
1. Stream 생성 후 **"Test Webhook"** 버튼 클릭
2. Supabase 로그에서 webhook 수신 확인
3. webhook_log 테이블에 데이터 저장 확인

## 6. 모니터링
- QuickNode Dashboard에서 Stream 상태 확인
- Delivery 성공/실패 통계 확인
- Supabase webhook_log 테이블에서 처리된 이벤트 확인

## 7. 주의사항
- Webhook URL은 공개적으로 접근 가능해야 함
- 보안을 위해 Authorization 헤더 사용 권장
- Rate limiting 고려 (대량 전송 시)
- Webhook 실패 시 재시도 정책 설정

## 8. 디버깅
문제 발생 시 확인 사항:
1. QuickNode Stream 상태 (Active/Paused)
2. Webhook URL 접근 가능 여부
3. Supabase Edge Function 로그
4. webhook_log 테이블의 raw_data 필드