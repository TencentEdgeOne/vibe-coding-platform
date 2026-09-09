import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      // Off because the rule's advice does not hold here, not because it is
      // inconvenient. The preview proxy serves this app under a path prefix it
      // strips before forwarding, so the framework only ever sees the stripped
      // path; next/link intercepts the click and routes on the client against
      // that path, landing outside the prefix with nothing left to correct it
      // from. A plain anchor asks for a fresh document, which the proxy does
      // see and does rewrite, so cross-page navigation here is <a href="/route">.
      // Leaving the rule on rejects exactly that: next build lints and next dev
      // does not, so every linked multi-page app previews green and then fails
      // to deploy.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
];

export default eslintConfig;
