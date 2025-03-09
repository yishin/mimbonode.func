import { supabase } from "./supabaseClient.ts";

/**
 * Edge Function 호출 추적을 위한 유틸리티 함수
 * @param supabase - Supabase 클라이언트
 * @param functionName - 호출된 함수의 이름
 * @param params - 호출된 함수의 매개변수
 * @returns 호출 ID
 */
export async function trackFunctionCall(functionName, params) {
  try {
    const { data, error } = await supabase
      .from("edge_function_calls")
      .insert({
        function_name: functionName,
        status: "started",
        params: params,
        metadata: {
          start_time: new Date().toISOString(),
        },
      })
      .select()
      .single();

    if (error) {
      console.error(
        `Error tracking function call start for ${functionName}:`,
        error,
      );
      return null;
    }

    return data.id;
  } catch (err) {
    console.error(
      `Exception tracking function call start for ${functionName}:`,
      err,
    );
    return null;
  }
}

/**
 * Edge Function 호출 완료 추적
 * @param callId - 호출 ID
 * @param result - 호출 결과
 * @param metadata - 호출 메타데이터
 */
export async function completeFunctionCall(
  callId,
  result,
  metadata = {},
) {
  if (!callId) return;

  const endTime = new Date();
  const startTime = new Date(metadata.start_time || endTime);
  const executionTime = (endTime - startTime) / 1000; // 초 단위로 변환

  try {
    const { error } = await supabase
      .from("edge_function_calls")
      .update({
        status: "completed",
        completed_at: endTime.toISOString(),
        result: result,
        execution_time: executionTime,
        metadata: {
          ...metadata,
          end_time: endTime.toISOString(),
        },
      })
      .eq("id", callId);

    if (error) {
      console.error(
        `Error tracking function call completion for ${callId}:`,
        error,
      );
    }
  } catch (err) {
    console.error(
      `Exception tracking function call completion for ${callId}:`,
      err,
    );
  }
}

/**
 * Edge Function 호출 실패 추적
 * @param callId - 호출 ID
 * @param error - 오류 객체
 * @param metadata - 호출 메타데이터
 */
export async function failFunctionCall(callId, error, metadata = {}) {
  if (!callId) return;

  const endTime = new Date();
  const startTime = new Date(metadata.start_time || endTime);
  const executionTime = (endTime - startTime) / 1000; // 초 단위로 변환

  try {
    const { error: dbError } = await supabase
      .from("edge_function_calls")
      .update({
        status: "failed",
        completed_at: endTime.toISOString(),
        error: error.message || String(error),
        execution_time: executionTime,
        metadata: {
          ...metadata,
          end_time: endTime.toISOString(),
          stack: error.stack,
        },
      })
      .eq("id", callId);

    if (dbError) {
      console.error(
        `Error tracking function call failure for ${callId}:`,
        dbError,
      );
    }
  } catch (err) {
    console.error(
      `Exception tracking function call failure for ${callId}:`,
      err,
    );
  }
}
