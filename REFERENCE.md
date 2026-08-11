# Set up AutoFactory

AutoFactory builds a release-ready change. Your CI/CD deploys it. LaunchDarkly releases it.

```text
Pull request → Build → Deploy → Release
```

## What you need

- Node.js 20+
- a GitHub application repository
- factory and app projects in LaunchDarkly
- LaunchDarkly server and API credentials
- an Anthropic API key

## 1. Bootstrap

```bash
git clone <this-repo-url>
cd launchdarkly-auto-factory
npm install
cp .env.example .env
```

Fill in `.env`, then run:

```bash
npm run bootstrap
```

This provisions the agents, graph, tools, Judges, flags, and metrics.

## 2. Add the Build workflow

Copy `bootstrap/github-action-template/auto-factory.yml` to the application repository at:

```text
.github/workflows/auto-factory.yml
```

Replace `<owner>`, then add these GitHub settings:

- Secrets: `LD_SDK_KEY`, `LD_API_KEY`, `ANTHROPIC_API_KEY`
- Variable: `LD_APP_PROJECT_KEY`

## 3. Open a pull request

AutoFactory researches the change, adds release controls and metrics, tests both flag paths,
reviews the diff, and writes a release manifest. New behavior stays off through deployment.

## 4. Connect Beacon

Deploy Beacon:

```bash
docker build -f packages/beacon/Dockerfile -t auto-factory-beacon .
docker run -p 8080:8080 --env-file beacon.env auto-factory-beacon
```

Configure `BEACON_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `LD_API_KEY`, `LD_PROJECT_KEY`, and your
services in `config/services.yaml`.

After deployment, send Beacon the service and SHA:

```json
{"service":"backend","sha":"<deployed-sha>","environment":"production"}
```

Beacon finds the manifest. LaunchDarkly controls exposure, evaluates the metrics, and
completes or rolls back the release.

## Other Build entry points

- [Claude Code or CLI](INSTALL-CLAUDE-CODE.md)
- [Cursor extension](packages/phase1-cursor-extension/)
- [Cursor automation](bootstrap/cursor-automation/)

## More detail

- [Beacon](packages/beacon/README.md)
- [Factory configuration](config/agentcontrol/README.md)
- [Detailed pipeline](docs/pipeline-overview.html)
