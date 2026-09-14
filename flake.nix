{
  description = "56 card game";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      perSystem =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpm = pkgs.pnpm_11.override { nodejs-slim = pkgs.nodejs_24; };
          fiftysix = pkgs.callPackage ./nix/package.nix { };
          source = pkgs.lib.cleanSource ./.;
          typecheck = fiftysix.overrideAttrs {
            pname = "fiftysix-typecheck";
            buildPhase = ''
              runHook preBuild
              pnpm typecheck
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              touch $out
              runHook postInstall
            '';
          };
          biome = pkgs.runCommand "fiftysix-biome" { nativeBuildInputs = [ pkgs.biome ]; } ''
            cd ${source}
            biome check .
            touch $out
          '';
        in
        {
          inherit
            biome
            fiftysix
            pkgs
            pnpm
            typecheck
            ;
        };
    in
    {
      packages = forAllSystems (system: {
        default = (perSystem system).fiftysix;
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${(perSystem system).fiftysix}/bin/fiftysix";
        };
      });

      devShells = forAllSystems (
        system:
        let
          inherit (perSystem system) pkgs pnpm;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pnpm
              pkgs.sqlite
              pkgs.biome
              pkgs.python3
              pkgs.stdenv.cc
              pkgs.pkg-config
              pkgs.nixfmt
            ];
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          inherit (perSystem system) biome fiftysix typecheck;
        in
        {
          inherit biome fiftysix typecheck;
        }
      );

      formatter = forAllSystems (system: (perSystem system).pkgs.nixfmt);

      nixosModules.default =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.fiftysix.package = lib.mkDefault self.packages.${pkgs.system}.default;
        };
    };
}
