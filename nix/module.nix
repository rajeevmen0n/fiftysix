{
  config,
  lib,
  ...
}:

let
  cfg = config.services.fiftysix;
in
{
  options.services.fiftysix = {
    enable = lib.mkEnableOption "the 56 card game server";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The fiftysix package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Host address on which the server listens.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8056;
      description = "TCP port on which the server listens.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the server port in the firewall.";
    };

    databaseUrl = lib.mkOption {
      type = lib.types.str;
      default = "sqlite:///var/lib/fiftysix/fiftysix.db";
      description = "Database URL used by the server.";
    };

    debugPasswordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "File containing the debug password, or null to disable /debug.";
    };

    allowedOrigins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "HTTP origins allowed to establish WebSocket connections; empty allows any origin.";
    };

    logLevel = lib.mkOption {
      type = lib.types.str;
      default = "info";
      description = "Server log level.";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.fiftysix = {
      description = "56 card game server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        DATABASE_URL = cfg.databaseUrl;
        LOG_LEVEL = cfg.logLevel;
      }
      // lib.optionalAttrs (cfg.allowedOrigins != [ ]) {
        ALLOWED_ORIGINS = lib.concatStringsSep "," cfg.allowedOrigins;
      }
      // lib.optionalAttrs (cfg.debugPasswordFile != null) {
        DEBUG_PASSWORD_FILE = "%d/debug-password";
      };

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/fiftysix";
        DynamicUser = true;
        StateDirectory = "fiftysix";
        Restart = "on-failure";
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
      }
      // lib.optionalAttrs (cfg.debugPasswordFile != null) {
        LoadCredential = [ "debug-password:${toString cfg.debugPasswordFile}" ];
      };
    };
  };
}
