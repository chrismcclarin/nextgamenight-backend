// Railway settings for the backend service (Railway "Infrastructure as Code").
// Generated 2026-11-19 by `railway config migrate` from railway.json, which Railway stops
// reading on 2026-12-01. Railway does NOT read this file during a deploy: a change here
// takes effect only when someone runs `railway config plan` and then `railway config apply`
// from this folder. Variables are unmanaged on purpose: this file never reads or writes them.
import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "GameCalendarbackendv2";
export default defineRailway(() => {
  const GameCalendarbackendv2 = service("GameCalendarbackendv2", {
    source: github("chrismcclarin/nextgamenight-backend", { branch: "main", checkSuites: false, rootDirectory: "/Sonnet" }),
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    preDeploy: "node scripts/log-db-resolution.js && npm run migrate:apply",
    replicas: { "us-west2": 1 },
    domains: [{ domain: "api.nextgamenight.app", port: 4000 }],
    networking: { privateNetworkEndpoint: "gamecalendarbackendv2" },
  });

  return project("terrific-success", {
    variables: { managed: false },
    resources: [GameCalendarbackendv2],
  });
});
