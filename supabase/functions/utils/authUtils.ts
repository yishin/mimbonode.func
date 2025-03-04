import { supabase } from "./supabaseClient.ts";

export async function authenticateRequest(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: "Authorization header missing", status: 401 };
  }

  //
  const token = authHeader.split(" ")[1];

  // 토큰 검증 후 사용자 정보 가져오기
  const { data: { user }, error: authError } = await supabase.auth.getUser(
    token,
  );

  if (authError || !user) {
    return {
      error: authError?.message || "Invalid or expired token",
      status: authError?.code || 401,
    };
  }

  // 사용자 프로필 가져오기
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (profileError) {
    return { error: profileError.message, status: 401 };
  }

  // 사용자 지갑 가져오기
  const { data: wallet, error: walletError } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", user.id)
    .single();

  // 모든 정책 가져오기
  const { data: settings, error: settingsError } = await supabase
    .from("settings")
    .select("key, value");

  if (settingsError) {
    return { error: settingsError.message, status: 401 };
  }

  // 읽어온 정책 리스트를 json 형식으로 변환
  const settingsJson = settings.reduce((acc: any, curr: any) => {
    acc[curr.key] = curr.value;
    return acc;
  }, {});

  return { user, profile, wallet, settings: settingsJson, status: 200 };
}
