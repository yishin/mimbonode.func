export const verifyTurnstileToken = async (token: string) => {
    const response = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                secret: Deno.env.get("TURNSTILE_SECRET_KEY"),
                response: token,
            }),
        },
    );
    return await response.json();
};
