export function setCorsHeaders(req: Request) {
    const headers = new Headers({
        "Content-Type": "application/json",
        "Access-Control-Allow-Methods":
            "POST, GET, PUT, DELETE, OPTIONS, HEAD, PATCH",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
    });

    const origin = req.headers.get("Origin");
    const allowedOrigins = [
        "http://localhost:5173",
        "http://localhost:54321",
        "https://preview.mimbonode.io",
        "https://www.mimbonode.io",
        "https://mining.mimbonode.io",
    ];

    // 개발 환경에서는 모든 오리진 허용
    if (origin && allowedOrigins.includes(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
    } else {
        headers.set(
            "Access-Control-Allow-Origin",
            "https://mining.mimbonode.io",
        );
    }

    // 자격 증명(쿠키 등) 허용
    headers.set("Access-Control-Allow-Credentials", "true");

    return headers;
}
