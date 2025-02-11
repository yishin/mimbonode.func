import { supabase } from "./supabaseClient.ts";

export async function authenticateRequest(req: Request) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
        return { error: "Authorization header missing", status: 401 };
    }

    const token = authHeader.replace("Bearer ", "");
    const { data, error: authError } = await supabase.auth.getUser(token);

    if (authError || !data?.user) {
        return { error: "Invalid or expired token", status: 401 };
    }

    return { user: data.user, status: 200 };
}
