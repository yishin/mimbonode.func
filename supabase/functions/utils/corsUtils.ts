export function setCorsHeaders(req: Request) {
    const headers = new Headers({
        "Content-Type": "application/json",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization, x-client-info, apikey",
        "Access-Control-Max-Age": "86400",
    });

    const origin = req.headers.get("Origin");
    const allowedOrigins = [
        "http://localhost:5173",
        "https://preview.mimbonode.io",
        "https://www.mimbonode.io",
        "https://mining.mimbonode.io",
    ];

    if (origin && allowedOrigins.includes(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
    } else {
        headers.set(
            "Access-Control-Allow-Origin",
            "https://mining.mimbonode.io",
        );
    }

    return headers;
}
