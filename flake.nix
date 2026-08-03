{
  description = "SecureLLM MCP Server - Hybrid Node.js/Rust Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Rust Overlay para versões precisas se necessário
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
    # Spider-Nix for web crawling/OSINT features
    spider-nix = {
      url = "git+ssh://git@github.com/VoidNxSEC/spider-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      rust-overlay,
      ...
    }@inputs:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        spiderNixPkg = inputs.spider-nix.packages.${system}.default;
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # Toolchain Rust estável com suporte a análise de código
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "rust-src"
            "rust-analyzer"
            "clippy"
          ];
        };

        # Build the MCP server package
        mcpServer = pkgs.buildNpmPackage {
          pname = "securellm-mcp";
          version = "2.1.0";

          src = ./.;

          env = {
            PUPPETEER_SKIP_DOWNLOAD = "1";
            PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = "1";
          };

          npmDepsHash = "sha256-uA78xn4dzPgLTivGSpapPIVtqzEyOPEAkRYGxzZPusY=";

          buildPhase = ''
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/mcp-server

            # Copy build output
            cp -r build $out/lib/mcp-server/
            cp package.json $out/lib/mcp-server/
            cp -r node_modules $out/lib/mcp-server/

            # Create executable wrapper with Chromium and spider-nix paths
            cat > $out/bin/securellm-mcp <<EOF
            #!${pkgs.bash}/bin/bash
            export PUPPETEER_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            export PUPPETEER_SKIP_DOWNLOAD="1"
            export SPIDER_NIX_BIN="${spiderNixPkg}/bin/spider-nix"

            exec ${pkgs.nodejs}/bin/node $out/lib/mcp-server/build/src/index.js "\$@"
            EOF
            chmod +x $out/bin/securellm-mcp
          '';

          meta = with pkgs.lib; {
            description = "MCP server for SecureLLM Bridge IDE integration";
            license = licenses.mit;
            maintainers = [ "kernelcore" ];
          };
        };
      in
      {
        formatter = pkgs.nixfmt;

        packages = {
          default = mcpServer;
          mcp = mcpServer;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Node.js Environment (Legacy/Transition)
            nodejs_24
            typescript
            typescript-language-server

            # Rust Environment (New Architecture)
            rustToolchain
            pkg-config
            openssl
            sqlite

            # Browser Automation
            chromium

            # OSINT/Web Crawling
            spiderNixPkg

            # Secrets Management
            sops
            age

            # Utils
            ripgrep
            jq
          ];

          shellHook = ''
            export LD_LIBRARY_PATH=${pkgs.openssl.out}/lib:$LD_LIBRARY_PATH
            export PUPPETEER_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
            export PUPPETEER_SKIP_DOWNLOAD="1"
            export SPIDER_NIX_BIN="${spiderNixPkg}/bin/spider-nix"
            if [ "''${SECURELLM_MCP_QUIET:-0}" != "1" ]; then
              echo "🛡️ SecureLLM Dev Environment (Node.js + Rust) Loaded"
              echo "Rust Version: $(rustc --version)"
              echo "Node Version: $(node --version)"
              echo "Chromium: ${pkgs.chromium}/bin/chromium"
              echo "Spider-Nix: ${spiderNixPkg}/bin/spider-nix"
            fi
          '';
        };
      }
    );
}
