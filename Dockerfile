# CPM Runner Demo — Claude Code in plain Docker container
# Mode A: Manual container with cc installed

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root agent user
RUN useradd -m -s /bin/bash agent

# Pre-configure cc: skip onboarding (required for headless OAuth)
RUN mkdir -p /home/agent/.claude && \
    echo '{"hasCompletedOnboarding": true}' > /home/agent/.claude.json && \
    chown -R agent:agent /home/agent/.claude /home/agent/.claude.json

USER agent
WORKDIR /workspace

# Default entrypoint: cc in headless prompt mode with YOLO
ENTRYPOINT ["claude", "-p", "--dangerously-skip-permissions"]
