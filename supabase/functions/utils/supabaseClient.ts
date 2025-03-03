import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let supabaseUrl = Deno.env.get("SUPABASE_URL");
let supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// localhost일때는 환경변수중 SUPABASE_로 시작되는 변수를 못 읽어서 다른 환경변수를 사용
if (!supabaseUrl || supabaseUrl === "http://kong:8000") {
  supabaseUrl = Deno.env.get("SB_URL");
  supabaseKey = Deno.env.get("SB_SERVICE_ROLE_KEY");
}

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Missing environment variables SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
  );
  Deno.exit(1);
}

let supabaseClient: any;

if (!supabaseClient) {
  supabaseClient = createClient(supabaseUrl, supabaseKey);
}

export const supabase = supabaseClient;

export const getAddressByUsername = async (username: string) => {
  const { data, error } = await supabase
    .from("wallets")
    .select("address")
    .eq("username", username)
    .single();

  if (error) {
    throw new Error("Wallet not found");
  }

  return data.address;
};

export const getAddressBySid = async (sid: string) => {
  const { data, error } = await supabase
    .from("wallets")
    .select("address")
    .eq("sid", sid)
    .single();

  if (error) {
    throw new Error("Wallet not found");
  }

  return data.address;
};
