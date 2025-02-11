// supabase/functions/updateTransactionStatus.js
import { serve } from "https://deno.land/std@0.131.0/http/server.ts";
import { supabase } from "../utils/supabaseClient.ts";

// Edge Function 시작
serve(async (req) => {
  try {
    // Webhook에서 JSON 데이터를 한 번만 파싱
    const { txHash, status } = await req.json();
    console.log("webhook received:", { txHash, status });

    if (!txHash || !status) {
      console.error("Missing required fields:", { txHash, status });
      return new Response("Invalid data: txHash and status are required", {
        status: 400,
      });
    }

    // 상태 유효성 검사
    const validStatuses = ["pending", "completed", "failed"];
    if (!validStatuses.includes(status)) {
      console.error("Invalid status:", status);
      return new Response("Invalid status value", { status: 400 });
    }

    // 트랜잭션 업데이트
    const { error } = await supabase
      .from("transactions")
      .update({ status })
      .eq("tx_hash", txHash);

    if (error) {
      console.error("Error updating transaction:", error);
      return new Response("Failed to update transaction", { status: 500 });
    }

    console.log("Transaction updated successfully:", { txHash, status });
    return new Response("Transaction updated successfully", { status: 200 });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response("Internal server error", { status: 500 });
  }
});
