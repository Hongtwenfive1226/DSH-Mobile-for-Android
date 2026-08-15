window.__ModuleLoader__.load({
  id: "dsh-mode-switcher",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    /** Cordis fiber inject: hard dependencies the plugin waits for. */
    var inject = ["slots", "connection"];

    function apply(ctx) {
      var slots = ctx.slots;
      var connection = ctx.connection;
      if (slots === undefined || connection === undefined) return;
      var api = connection.api;
      if (api === undefined || api.agentPresets === undefined) return;
      var sessions = ctx.get("sessions");

      function ModeSwitch(props) {
        var sessionId = props.sessionId;
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var presetsState = React.useState([]);
        var presets = presetsState[0];
        var setPresets = presetsState[1];
        var currentState = React.useState(undefined);
        var current = currentState[0];
        var setCurrent = currentState[1];
        var errorState = React.useState(null);
        var error = errorState[0];
        var setError = errorState[1];
        var busyState = React.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];

        // Load the preset roster once.
        React.useEffect(function () {
          var alive = true;
          api.agentPresets.list({}).then(function (res) {
            if (!alive) return;
            if (res && res.result && res.result.ok) {
              var rows = res.result.value.presets || [];
              setPresets(rows.map(function (p) {
                return {
                  id: p.id,
                  name: p.name || p.id,
                  broken: p.broken !== undefined,
                };
              }));
            } else if (res && res.result && !res.result.ok) {
              setError(res.result.error && res.result.error.message ? res.result.error.message : "failed to list presets");
            }
          }).catch(function (e) {
            if (alive) setError(e && e.message ? e.message : String(e));
          });
          return function () { alive = false; };
        }, []);

        // Track the session's current preset reactively from the sessions store.
        React.useEffect(function () {
          if (sessions === undefined || sessions.list === undefined) return;
          var list = sessions.list;
          var alive = true;
          function update() {
            var snap = list.getSnapshot();
            var s = snap && snap.byId ? snap.byId[sessionId] : undefined;
            if (alive) setCurrent(s ? s.agentPreset : undefined);
          }
          update();
          var unsub = list.subscribe(update);
          return function () {
            alive = false;
            if (unsub) unsub();
          };
        }, [sessionId]);

        function doSwitch(id) {
          setOpen(false);
          setBusy(true);
          setError(null);
          api.agentPresets.select({ sessionId: sessionId, agentPreset: id }).then(function (res) {
            setBusy(false);
            if (res && res.result && res.result.ok) {
              setCurrent(res.result.value.agentPreset);
            } else {
              setError(res && res.result && res.result.error ? res.result.error.message : "switch failed");
            }
          }).catch(function (e) {
            setBusy(false);
            setError(e && e.message ? e.message : String(e));
          });
        }

        var currentLabel = undefined;
        for (var i = 0; i < presets.length; i += 1) {
          if (presets[i].id === current) currentLabel = presets[i].name;
        }

        var btnStyle = {
          background: "transparent",
          border: "1px solid var(--dsw-alias-border-l2, #ddd)",
          borderRadius: 8,
          padding: "4px 10px",
          cursor: busy ? "wait" : "pointer",
          fontSize: 13,
          color: "var(--dsw-alias-label-primary, #111)",
          whiteSpace: "nowrap",
        };
        var menuStyle = {
          position: "absolute",
          top: "calc(100% + 4px)",
          right: 0,
          zIndex: 1000,
          background: "var(--dsw-alias-bg-base, #fff)",
          border: "1px solid var(--dsw-alias-border-l2, #ddd)",
          borderRadius: 8,
          padding: 4,
          minWidth: 180,
          boxShadow: "0 6px 24px rgba(0,0,0,.18)",
        };
        var itemBase = {
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "8px 10px",
          border: "none",
          background: "none",
          cursor: "pointer",
          borderRadius: 6,
          fontSize: 13,
          color: "var(--dsw-alias-label-primary, #111)",
        };

        var items = presets.map(function (p) {
          var active = p.id === current;
          return React.createElement("button", {
            key: p.id,
            type: "button",
            style: Object.assign({}, itemBase, {
              fontWeight: active ? 700 : 400,
              color: active ? "var(--dsw-alias-brand-primary, #3964fe)" : itemBase.color,
              opacity: p.broken ? 0.5 : 1,
              cursor: p.broken ? "not-allowed" : "pointer",
            }),
            disabled: p.broken || busy,
            onClick: function () { doSwitch(p.id); },
          }, (p.name || p.id) + (active ? " ✓" : ""));
        });

        return React.createElement("div", { style: { position: "relative", display: "inline-flex" } },
          React.createElement("button", {
            type: "button",
            style: btnStyle,
            disabled: busy,
            title: error || undefined,
            onClick: function () { setOpen(!open); },
          }, "🔄 " + (currentLabel || "切换模式")),
          open ? React.createElement("div", { style: menuStyle }, items) : null
        );
      }

      slots.inject("conversation.session.header.actions", function () {
        return slots.register(
          {
            name: "conversation.session.header.actions",
            id: "mode-switcher",
            order: 30,
            label: "切换模式",
          },
          function (props) {
            return React.createElement(ModeSwitch, { sessionId: props.sessionId });
          }
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
