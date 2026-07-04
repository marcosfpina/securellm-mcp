{
  description = "VoidNxLabs software registry consumer — fetch and build software from public API";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Fetch software metadata from public registry
        fetchSoftware =
          name:
          pkgs.runCommand "fetch-${name}"
            {
              buildInputs = [
                pkgs.curl
                pkgs.jq
              ];
            }
            ''
              curl -s https://api.voidnxlabs.io/softwares/${name} | \
                jq -r '.data | "\(.name) \(.version) \(.source_url)"' > $out
            '';

      in
      {
        # Flake for consuming voidnxlabs software registry
        packages = {
          # Example: spider-nix
          spider-nix = pkgs.stdenv.mkDerivation {
            name = "spider-nix";
            src = pkgs.fetchFromGitHub {
              owner = "voidnxlabs";
              repo = "spider-nix";
              rev = "main";
              sha256 = "0000000000000000000000000000000000000000000000000000";
            };
            buildInputs = [
              pkgs.cargo
              pkgs.rustc
            ];
            buildPhase = "cargo build --release";
            installPhase = "mkdir -p $out/bin && cp target/release/spider-nix $out/bin/";
          };

          # Example: cerebro
          cerebro = pkgs.stdenv.mkDerivation {
            name = "cerebro";
            src = pkgs.fetchFromGitHub {
              owner = "voidnxlabs";
              repo = "cerebro";
              rev = "main";
              sha256 = "0000000000000000000000000000000000000000000000000000";
            };
            buildInputs = [
              pkgs.cargo
              pkgs.rustc
            ];
            buildPhase = "cargo build --release";
            installPhase = "mkdir -p $out/bin && cp target/release/cerebro $out/bin/";
          };

          # Dev environment for consuming the registry
          registry-client = pkgs.writeShellScriptBin "voidnx-registry" ''
            set -euo pipefail
            API_BASE="https://api.voidnxlabs.io"

            case "''${1:-help}" in
              list)
                echo "📦 Available VoidNxLabs Software:"
                curl -s "$API_BASE/softwares" | ${pkgs.jq}/bin/jq -r '.[] | "\(.name) (\(.version)) - \(.description)"'
                ;;
              info)
                if [ -z "''${2:-}" ]; then
                  echo "Usage: voidnx-registry info <software-name>"
                  exit 1
                fi
                curl -s "$API_BASE/softwares/$2" | ${pkgs.jq}/bin/jq '.data'
                ;;
              *)
                echo "VoidNxLabs Software Registry Client"
                echo "Usage: voidnx-registry <command>"
                echo ""
                echo "Commands:"
                echo "  list           List all available software"
                echo "  info <name>    Show metadata for a specific software"
                ;;
            esac
          '';
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            cargo
            rustc
            curl
            jq
            pkg-config
          ];
          shellHook = ''
            echo "VoidNxLabs Consumer Environment"
            echo "Available commands:"
            echo "  - nix flake show              # Show all packages"
            echo "  - nix run .#registry-client   # Interact with registry"
          '';
        };
      }
    );
}
