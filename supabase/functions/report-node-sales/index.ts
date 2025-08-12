// Supabase edge function for reporting daily node sales
// Deno.serve is now built-in, no import needed
import { supabase } from "../utils/supabaseClient.ts";
import { setCorsHeaders } from "../utils/corsUtils.ts";

const sendUsers = ["urus6000"];

console.log("Report Node Sales function started");

// 텔레그램 관련 설정
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");

// 한국 시간(KST) 설정을 위한 상수
const KST_OFFSET = 9 * 60 * 60 * 1000; // UTC+9 (9시간)

// 집계 시작일 설정 (2025년 4월 16일)
const INITIAL_START_DATE = new Date("2025-04-16T00:00:00+09:00");

// 날짜를 한국 시간 기준 YYYY-MM-DD 형식으로 변환
function formatKoreanDate(date: Date): string {
  const kstDate = new Date(date.getTime() + KST_OFFSET);
  return kstDate.toISOString().split("T")[0];
}

// 날짜 범위를 생성 (한국 시간 기준)
function getDateRange(date: Date, days = 0) {
  // 한국 시간으로 변환
  const kstDate = new Date(date.getTime() + KST_OFFSET);

  // 연, 월, 일만 추출
  const year = kstDate.getUTCFullYear();
  const month = kstDate.getUTCMonth();
  const day = kstDate.getUTCDate();

  // 시작일 설정 (해당 날짜의 한국 시간 00:00:00)
  const start = new Date(Date.UTC(year, month, day - days));

  // 종료일 설정 (해당 날짜의 한국 시간 23:59:59)
  const end = new Date(Date.UTC(year, month, day));

  return {
    start: new Date(start.getTime() - KST_OFFSET), // UTC로 변환
    end: new Date(end.getTime() - KST_OFFSET), // UTC로 변환
    startStr: formatKoreanDate(start),
    endStr: formatKoreanDate(end),
  };
}

// 월별 집계 범위 계산 (전월 10일 ~ 현재월 9일)
function getMonthlyReportRange(
  yesterday: Date,
): { startDate: Date; endDate: Date; periodTitle: string } {
  // 한국 시간으로 변환
  const kstDate = new Date(yesterday.getTime() + KST_OFFSET);

  // 어제 날짜 정보
  const year = kstDate.getUTCFullYear();
  const month = kstDate.getUTCMonth();
  const day = kstDate.getUTCDate();

  let startYear = year;
  let startMonth = month;
  let _endYear = year;
  let _endMonth = month;

  // 어제가 9일 이하인지 확인
  if (day <= 9) {
    // 이전월 10일 ~ 현재월 9일 (어제까지)
    startMonth = month - 1;
    if (startMonth < 0) {
      startMonth = 11; // 12월
      startYear--;
    }
  } else {
    // 현재월 10일 ~ 어제까지
    _endMonth = month;
    _endYear = year;
  }

  // 날짜 범위 설정 (한국 시간 기준)
  const startDate = new Date(Date.UTC(startYear, startMonth, 10)); // 시작월 10일
  const endDate = new Date(yesterday.getTime()); // 어제 날짜까지

  // 시작일이 초기 기준일(2025-04-16)보다 이전이면 초기 기준일로 조정
  if (startDate < INITIAL_START_DATE) {
    startDate.setTime(INITIAL_START_DATE.getTime());
  }

  // 문자열로 표시할 기간 설정
  const startDateStr = formatKoreanDate(startDate);
  const endDateStr = formatKoreanDate(endDate);

  // UTC로 변환 (Supabase 쿼리용)
  const utcStartDate = new Date(startDate.getTime() - KST_OFFSET);
  const utcEndDate = new Date(endDate.getTime());

  return {
    startDate: utcStartDate,
    endDate: utcEndDate,
    periodTitle: `${startDateStr} ~ ${endDateStr}`,
  };
}

// 텔레그램으로 메시지 전송
async function sendTelegramMessage(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram configuration");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      },
    );

    const result = await response.json();
    console.log("Telegram message sent:", result);
    return result;
  } catch (error) {
    console.error("Error sending Telegram message:", error);
    return null;
  }
}

interface PackageSalesItem {
  price: number;
}

interface SalesItem {
  to_amount: number;
}

// 판매 보고서 생성 및 전송
async function generateAndSendReport() {
  try {
    // 현재 날짜 정보 (UTC 기준)
    const now = new Date();

    // 어제 날짜 범위 계산 (한국 시간 기준)
    const yesterday = getDateRange(now, 1);

    // 월별 집계 범위 계산 (전월 11일 ~ 현재월 10일 또는 어제까지)
    const {
      startDate: monthlyStartDate,
      endDate: monthlyEndDate,
      periodTitle: monthlyPeriodTitle,
    } = getMonthlyReportRange(yesterday.start);

    console.log(
      `Fetching daily sales data for: ${yesterday.startStr} ~ ${yesterday.endStr}`,
    );
    console.log(
      `Fetching monthly sales for period: ${
        formatKoreanDate(monthlyStartDate)
      } ~ ${formatKoreanDate(monthlyEndDate)}`,
    );

    // 어제 하루 동안의 판매 데이터 쿼리
    const { data: dailyData, error: dailyError } = await supabase
      .from("mypackages")
      .select("price")
      .eq("is_free", false)
      .gte("purchase_date", yesterday.start.toISOString())
      .lt("purchase_date", yesterday.end.toISOString());

    if (dailyError) {
      console.error("Error fetching daily sales data:", dailyError);
      return { success: false, error: dailyError.message };
    }

    // 월별 판매 데이터 쿼리 (전월 11일 ~ 이번달 10일 또는 어제까지)
    const { data: monthlyData, error: monthlyError } = await supabase
      .from("mypackages")
      .select("price")
      .eq("is_free", false)
      .gte("purchase_date", monthlyStartDate.toISOString())
      .lt("purchase_date", yesterday.end.toISOString());

    if (monthlyError) {
      console.error("Error fetching monthly sales data:", monthlyError);
      return { success: false, error: monthlyError.message };
    }

    // 영업지원 금액 데이터 쿼리 - 일일
    const { data: dailySalesData, error: dailySalesError } = await supabase
      .from("transactions")
      .select("to_amount")
      .in("from", sendUsers)
      .eq("transaction_type", "TRANSFER")
      .eq("to_token", "USDT")
      .gte("created_at", yesterday.start.toISOString())
      .lt("created_at", yesterday.end.toISOString());

    if (dailySalesError) {
      console.error(
        "Error fetching daily sales support funds:",
        dailySalesError,
      );
      return { success: false, error: dailySalesError.message };
    }

    // 영업지원 금액 데이터 쿼리 - 월별
    const { data: monthlySalesData, error: monthlySalesError } = await supabase
      .from("transactions")
      .select("to_amount")
      .in("from", sendUsers)
      .eq("transaction_type", "TRANSFER")
      .eq("to_token", "USDT")
      .gte("created_at", monthlyStartDate.toISOString())
      .lt("created_at", yesterday.end.toISOString());

    if (monthlySalesError) {
      console.error(
        "Error fetching monthly sales support funds:",
        monthlySalesError,
      );
      return { success: false, error: monthlySalesError.message };
    }

    // 영업지원 금액 계산
    const dailySalesTotal = (dailySalesData as SalesItem[])?.reduce(
      (sum: number, item: SalesItem) => sum + (Number(item.to_amount) || 0),
      0,
    ) || 0;

    const monthlySalesTotal = (monthlySalesData as SalesItem[])?.reduce(
      (sum: number, item: SalesItem) => sum + (Number(item.to_amount) || 0),
      0,
    ) || 0;

    // 판매 금액 계산
    const dailyTotal = (dailyData as PackageSalesItem[]).reduce(
      (sum: number, item: PackageSalesItem) => sum + (Number(item.price) || 0),
      0,
    );
    const dailyFeeAmount = (dailyTotal - dailySalesTotal) * 0.03; // 3% 수수료

    const monthlyTotal = (monthlyData as PackageSalesItem[]).reduce(
      (sum: number, item: PackageSalesItem) => sum + (Number(item.price) || 0),
      0,
    );
    const monthlyFeeAmount = (monthlyTotal - monthlySalesTotal) * 0.03; // 3% 수수료

    // 메시지 생성 (날짜를 한국 시간으로 표시)
    const message = `
<b>📊 노드 판매 보고서</b>

<b>1. 어제 판매 현황:</b>
(${yesterday.startStr} KST)

총 판매액: ${dailyTotal.toLocaleString()} USDT (${dailyData.length || 0}건)
총 영업지원: ${dailySalesTotal.toLocaleString()} USDT (${
      (dailySalesData as SalesItem[])?.length || 0
    }건)
실 판매: ${(dailyTotal - dailySalesTotal).toLocaleString()} USDT
정산(3%): ${dailyFeeAmount.toLocaleString()} USDT

<b>2. 월별 판매 현황</b>
(${monthlyPeriodTitle})

총 판매액: ${monthlyTotal.toLocaleString()} USDT
총 영업지원: ${monthlySalesTotal.toLocaleString()} USDT
총 실 판매: ${(monthlyTotal - monthlySalesTotal).toLocaleString()} USDT
총 정산(3%): ${monthlyFeeAmount.toLocaleString()} USDT
`;

    // 텔레그램으로 전송
    await sendTelegramMessage(message);

    return {
      success: true,
      message: "Report sent successfully",
      date: yesterday.startStr,
      daily_total: dailyTotal,
      daily_fee: dailyFeeAmount,
      daily_count: dailyData.length,
      daily_sales_total: dailySalesTotal,
      daily_sales_count: (dailySalesData as SalesItem[])?.length || 0,
      monthly_period: monthlyPeriodTitle,
      monthly_total: monthlyTotal,
      monthly_fee: monthlyFeeAmount,
      monthly_count: monthlyData.length,
      monthly_sales_total: monthlySalesTotal,
      monthly_sales_count: (monthlySalesData as SalesItem[])?.length || 0,
    };
  } catch (error) {
    console.error("Error generating report:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

// Edge Function 시작
Deno.serve(async (req) => {
  const headers = setCorsHeaders(req);

  // OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  try {
    // HTTP 요청 메서드 확인
    const { method } = req;

    // CRON job이나 수동 요청 처리
    if (method === "POST" || method === "GET") {
      const result = await generateAndSendReport();

      console.log("Report generated:", result.success ? "success" : "failed");

      return new Response(JSON.stringify(result), {
        status: 200,
        headers,
      });
    }

    // 지원하지 않는 메서드
    console.log("Method not allowed:", method);

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers,
    });
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/report-node-sales' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

*/
