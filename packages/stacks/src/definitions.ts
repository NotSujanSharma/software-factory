/**
 * Built-in stack templates.
 *
 * These are starting points, not a closed list. The architect agent picks one and
 * overrides whatever it needs - or declares a custom stack outright - so an
 * ecosystem missing from this file is still buildable. What a template buys is a
 * sane default and toolchain detection for an existing repo.
 */
import type { StackDefinition } from "./types.ts";

export const STACKS: StackDefinition[] = [
  {
    id: "node",
    label: "Node.js",
    language: "JavaScript/TypeScript",
    manifests: ["package.json"],
    commands: {
      install: ["npm", "install", "--no-audit", "--no-fund"],
      test: ["npm", "test"],
      start: ["npm", "start"],
    },
    portEnv: "PORT",
    errorSdk: "node",
    requires: ["node", "npm"],
    ignore: ["node_modules/", "dist/", ".env"],
    notes:
      "package.json needs `start` and `test` scripts. Prefer the standard library " +
      "(node:test, node:sqlite) over dependencies where it is reasonable.",
  },
  {
    id: "python",
    label: "Python",
    language: "Python",
    manifests: ["pyproject.toml", "requirements.txt", "Pipfile"],
    commands: {
      install: ["python", "-m", "pip", "install", "-r", "requirements.txt"],
      test: ["python", "-m", "pytest", "-q"],
      start: ["python", "main.py"],
      lint: ["python", "-m", "ruff", "check", "."],
    },
    portEnv: "PORT",
    errorSdk: "python",
    requires: ["python"],
    ignore: ["__pycache__/", "*.pyc", ".venv/", "venv/", ".pytest_cache/", ".env"],
    notes:
      "Pin dependencies in requirements.txt. For FastAPI use " +
      "`uvicorn app:app --host 0.0.0.0 --port $PORT`; for Flask, `flask run` or a " +
      "`__main__` block reading the port. Tests run under pytest.",
  },
  {
    id: "go",
    label: "Go",
    language: "Go",
    manifests: ["go.mod"],
    commands: {
      install: ["go", "mod", "download"],
      build: ["go", "build", "-o", "app", "./..."],
      test: ["go", "test", "./..."],
      start: ["go", "run", "."],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["go"],
    ignore: ["app", "app.exe", "bin/", ".env"],
    notes: "Use the standard library net/http unless the requirements need more. Tests are `go test ./...`.",
  },
  {
    id: "rust",
    label: "Rust",
    language: "Rust",
    manifests: ["Cargo.toml"],
    commands: {
      build: ["cargo", "build", "--release"],
      test: ["cargo", "test"],
      start: ["cargo", "run", "--release"],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["cargo"],
    ignore: ["target/", ".env"],
    notes: "axum or actix-web are reasonable choices. `cargo test` is the gate.",
  },
  {
    id: "ruby",
    label: "Ruby",
    language: "Ruby",
    manifests: ["Gemfile"],
    commands: {
      install: ["bundle", "install"],
      test: ["bundle", "exec", "rspec"],
      start: ["bundle", "exec", "ruby", "app.rb"],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["ruby", "bundle"],
    ignore: ["vendor/bundle/", ".bundle/", ".env"],
    notes: "Sinatra for small services, Rails when the requirements justify it.",
  },
  {
    id: "java-maven",
    label: "Java (Maven)",
    language: "Java",
    manifests: ["pom.xml"],
    commands: {
      build: ["mvn", "-q", "package", "-DskipTests"],
      test: ["mvn", "-q", "test"],
      start: ["mvn", "-q", "spring-boot:run"],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["mvn", "java"],
    ignore: ["target/", ".env"],
    notes: "Spring Boot reads SERVER_PORT; map the port env var explicitly in application.properties.",
  },
  {
    id: "java-gradle",
    label: "Java (Gradle)",
    language: "Java",
    manifests: ["build.gradle", "build.gradle.kts"],
    commands: {
      build: ["gradle", "build", "-x", "test"],
      test: ["gradle", "test"],
      start: ["gradle", "bootRun"],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["gradle", "java"],
    ignore: ["build/", ".gradle/", ".env"],
    notes: "Spring Boot reads SERVER_PORT; map the port env var explicitly.",
  },
  {
    id: "dotnet",
    label: ".NET",
    language: "C#",
    manifests: ["*.csproj", "*.sln"],
    commands: {
      install: ["dotnet", "restore"],
      build: ["dotnet", "build", "-c", "Release"],
      test: ["dotnet", "test"],
      start: ["dotnet", "run", "-c", "Release"],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["dotnet"],
    ignore: ["bin/", "obj/", ".env"],
    notes: "ASP.NET Core reads ASPNETCORE_URLS; set it from the port env var at startup.",
  },
  {
    id: "php",
    label: "PHP",
    language: "PHP",
    manifests: ["composer.json"],
    commands: {
      install: ["composer", "install", "--no-interaction"],
      test: ["vendor/bin/phpunit"],
      start: ["php", "-S", "0.0.0.0:8080", "-t", "public"],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["php", "composer"],
    ignore: ["vendor/", ".env"],
    notes: "The built-in server needs the port baked into the start command; rewrite it to match the assigned port.",
  },
  {
    id: "static",
    label: "Static site",
    language: "HTML/CSS/JS",
    manifests: ["index.html"],
    commands: {
      test: ["node", "--test"],
      start: ["npx", "--yes", "serve", "-l", "8080", "."],
    },
    portEnv: "PORT",
    errorSdk: "http",
    requires: ["node"],
    ignore: ["node_modules/", "dist/"],
    notes: "A pure frontend still needs a server process the factory can start and health-check.",
  },
];

export function stackById(id: string): StackDefinition | undefined {
  return STACKS.find((s) => s.id === id);
}

/** One line per stack, for the architect prompt. */
export function stackCatalogue(): string {
  return STACKS.map((s) => `- \`${s.id}\` - ${s.label} (${s.language}); detected by ${s.manifests.join(", ")}`).join(
    "\n",
  );
}
