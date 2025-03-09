import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import {
  getAddressBySid,
  getAddressByUsername,
  supabase,
} from "../utils/supabaseClient.ts";
import {
  getBnbBalance,
  getMggBalance,
  getUsdtBalance,
  sendBnb,
  sendMgg,
  sendUsdt,
  setOperationWallet,
} from "../utils/tokenUtils.ts";
import { setCorsHeaders } from "../utils/corsUtils.ts";
import { authenticateRequest } from "../utils/authUtils.ts";

// Edge Function 시작
serve(async (req) => {
  const headers = setCorsHeaders(req);

  // OPTIONS 요청 처리
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  try {
    // 사용자 인증
    const authResult = await authenticateRequest(req);
    if (authResult.error) {
      return new Response(
        JSON.stringify({ error: authResult.error }),
        {
          status: authResult.status,
          headers,
        },
      );
    }

    //
    const { user, profile, wallet, settings } = authResult;
    console.log("user_id:" + JSON.stringify(user.id));

    // 요청 데이터 파싱 : 없음
    const { fullname } = await req.json();

    if (fullname) {
      const { data, error } = await supabase
        .from("profiles")
        .update({ full_name: fullname })
        .eq("id", user.id);

      if (error) {
        console.error("Failed to update profile:", error);
        return new Response(
          JSON.stringify({ success: false, error: "Failed to update profile" }),
          { status: 200, headers },
        );
      }
    }

    // 성공 응답
    return new Response(
      JSON.stringify({ success: true, message: "Profile updated" }),
      { status: 200, headers },
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers },
    );
  }
});
