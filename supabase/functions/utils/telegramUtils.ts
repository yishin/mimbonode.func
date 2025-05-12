// 텔레그램 관련 설정
const ENV = Deno.env.get("ENV");
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const TELEGRAM_NOTIFY_ID = Deno.env.get("TELEGRAM_NOTIFY_ID");

export async function sendTelegramMessage(message: string) {
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
          chat_id: ENV === "production" ? TELEGRAM_NOTIFY_ID : TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      },
    );

    const result = await response.json();
    console.log("💬 Telegram message sent:", result);
    return result;
  } catch (error) {
    console.error("❌ Error sending Telegram message:", error);
    return null;
  }
}
