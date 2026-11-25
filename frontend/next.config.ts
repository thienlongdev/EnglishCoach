import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    // The tab title resolves at once from a request header: keep it in <head> from the first byte for every visitor.
    htmlLimitedBots: /.*/,
    experimental: {
        optimizePackageImports: ["lucide-react", "framer-motion", "@base-ui/react"],
    },
    async rewrites() {
        // Development only: the real-mic QA page talks to a local AI service. In production Nginx sends /api/v1/** to
        // the backend, so this rewrite was dead configuration there; it is not built into production at all.
        if (process.env.NODE_ENV === "production") return [];
        const aiServiceInternalUrl = process.env.AI_SERVICE_INTERNAL_URL || "http://ai-service:8000";
        return [
            {
                source: "/api/v1/real-mic-pack/:path*",
                destination: `${aiServiceInternalUrl}/api/v1/real-mic-pack/:path*`,
            },
        ];
    },
};

export default nextConfig;
