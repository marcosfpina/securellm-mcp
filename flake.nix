{
  description = "SecureLLM MCP Server - Hybrid Node.js/Rust Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Rust Overlay para versões precisas se necessário
    rust-overlay.url = "github:oxalica/rust-overlay";
    rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };
        
        # Toolchain Rust estável com suporte a análise de código
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" "clippy" ];
        };

        # Build the MCP server package
        mcpServer = pkgs.buildNpmPackage {
          pname = "securellm-bridge-mcp";
          version = "2.1.0";

          src = ./.;

          npmDepsHash = "sha256-KF7JPawB3W7jKO8gE5lqxWnZ9x3pMMJiHbKE1Ok5fUU=";

          buildPhase = ''
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/mcp-server

            # Copy build output
            cp -r build $out/lib/mcp-server/
            cp package.json $out/lib/mcp-server/
            cp -r node_modules $out/lib/mcp-server/

            # Create executable wrapper
            cat > $out/bin/securellm-mcp <<EOF
            #!${pkgs.bash}/bin/bash
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
        packages = {
          default = mcpServer;
          mcp = mcpServer;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Node.js Environment (Legacy/Transition)
            nodejs_20
            nodePackages.npm
            nodePackages.typescript
            nodePackages.typescript-language-server

            # Rust Environment (New Architecture)
            rustToolchain
            pkg-config
            openssl
            sqlite

            # Utils
            ripgrep
            jq
          ];

          shellHook = ''
            export LD_LIBRARY_PATH=${pkgs.openssl.out}/lib:$LD_LIBRARY_PATH
            echo "🛡️ SecureLLM Dev Environment (Node.js + Rust) Loaded"
            echo "Rust Version: $(rustc --version)"
            echo "Node Version: $(node --version)"
          '';
        };
      }
    );
}