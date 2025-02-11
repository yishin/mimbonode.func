import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let supabaseUrl = Deno.env.get("SUPABASE_URL");
let supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// const isDebugMode = Deno.env.get("DEBUG_MODE") === "true";
// if (isDebugMode) {
//     supabaseKey = Deno.env.get("DEBUG_KEY");
// }

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
