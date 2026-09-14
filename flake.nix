{
  description = "56 card game";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.callPackage ./nix/package.nix { };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpm = pkgs.pnpm_11.override { nodejs-slim = pkgs.nodejs_24; };
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

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.nixfmt
      );
    };
}
