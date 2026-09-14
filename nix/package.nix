{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  nodejs_24,
  pnpm_11,
  python3,
  pkg-config,
  sqlite,
  makeWrapper,
}:

let
  pnpm = pnpm_11.override { nodejs-slim = nodejs_24; };
in
stdenv.mkDerivation (finalAttrs: {
  pname = "fiftysix";
  version = "0.0.0";

  src = lib.cleanSource ../.;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 3;
    hash = "sha256-guqb2BBtIPXOejD/ejarEraAAiWxXgH1+cO1yaAZnic=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm
    pnpmConfigHook
    python3
    pkg-config
    stdenv.cc
    makeWrapper
  ];

  buildInputs = [ sqlite ];

  buildPhase = ''
    runHook preBuild

    betterSqlitePath=node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
    substituteInPlace $betterSqlitePath/binding.gyp \
      --replace-fail "'dependencies': ['deps/sqlite3.gyp:sqlite3']," \
        "'include_dirs': ['${sqlite.dev}/include'], 'libraries': ['-L${sqlite.out}/lib', '-lsqlite3'], 'defines': ['SQLITE_ENABLE_COLUMN_METADATA'],"
    pushd $betterSqlitePath
    npm run build-release --offline --nodedir=${nodejs_24}
    rm -rf build/Release/.deps build/Release/obj build/Release/obj.target \
      build/Release/test_extension.node
    popd

    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm644 dist/server/server.js $out/lib/fiftysix/server.js
    cp -r dist/web $out/lib/fiftysix/web

    mkdir -p $out/lib/fiftysix/node_modules
    cp -r node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 \
      $out/lib/fiftysix/node_modules/better-sqlite3
    cp -r node_modules/.pnpm/bindings@*/node_modules/bindings \
      $out/lib/fiftysix/node_modules/bindings
    cp -r node_modules/.pnpm/file-uri-to-path@*/node_modules/file-uri-to-path \
      $out/lib/fiftysix/node_modules/file-uri-to-path

    makeWrapper ${nodejs_24}/bin/node $out/bin/fiftysix \
      --add-flags $out/lib/fiftysix/server.js

    runHook postInstall
  '';
})
