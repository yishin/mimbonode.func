import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

let supabaseUrl = Deno.env.get("SUPABASE_URL");
let supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const isDebugMode = Deno.env.get("DEBUG_MODE") === "true";
if (isDebugMode) {
    supabaseUrl = "https://xgrbjyqqckbwpuyolqwu.supabase.co";
    supabaseKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhncmJqeXFxY2tid3B1eW9scXd1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcyMTAyNDI1MSwiZXhwIjoyMDM2NjAwMjUxfQ.2SeESr_NozdlwsaUNghbw3pYiBp_eiRk_KIj2A_XVkc";
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
