---
name: jdi-clj
description: Use this when writing or updating Clojure scripts/tools that debug JVMs via this repo's jdi-clj library.
---

Start the Clojure process with the launcher script (relative to this skill file):

```
scripts/start-nrepl.sh
```

The script starts a process with jdi-clj on the classpath and an nREPL server running. The nREPL port will be output when the process starts.

API namespaces, designed to be used aliased:

- `jdi-clj.connect`
- `jdi-clj.dispatch`
- `jdi-clj.requests`
- `jdi-clj.inspect`

## Common workflow

1. Connect/launch VM.
2. Build a session with `dispatch/session`.
3. Register breakpoints/requests with `requests/*`.
4. Run loop (`dispatch/events!` blocking, or `dispatch/start!` background).
5. Inspect/mutate state in callbacks using `inspect/*`.
6. Clean up requests with `requests/disable!`/`delete!`.

## Fast decision table

| Need | Use |
|---|---|
| Break on line in class (loaded now + future loads) | `requests/breakpoint!` |
| Break on exact `Location` you already have | `requests/breakpoint-request!` |
| Exception trapping by exception class | `requests/exception-breakpoint!` |
| Method-level tracing by method name | `requests/method-entry-breakpoint!` / `requests/method-exit-breakpoint!` |
| Field read/write watch | `requests/access-watchpoint!` / `requests/modification-watchpoint!` |
| Thread stepping after a hit | `requests/step-into!` / `step-over!` / `step-out!` |
| One-time callback | `dispatch/once` or `{:once? true}` in request options |
| Toggle/delete many related requests | keep returned handle + `requests/enable!` / `disable!` / `delete!` |
| Read or mutate target locals/fields | `inspect/local-value`, `inspect/set-local-value!`, `inspect/field-value`, `inspect/set-field-value!` |

## Quick patterns

### 1) Launch and run a breakpoint script

```clojure
(require '[jdi-clj.connect :as connect]
         '[jdi-clj.dispatch :as dispatch]
         '[jdi-clj.requests :as req])

(let [vm (connect/launch {:options "-cp target/classes"
                          :main    "com.acme.Main"})
      session (dispatch/session vm)]
  (req/breakpoint! session {:class "com.acme.Main" :line 42}
     (fn [ctx] (println "hit" (:location ctx))))
  (dispatch/events! session))
```

### 2) Attach to existing JVM

```clojure
(def vm (connect/socket "127.0.0.1:5005")) ; or (connect/process 12345)
(def session (dispatch/session vm))
```

### 3) One-shot handler

```clojure
(req/method-entry-breakpoint! session {:class "com.acme.Service" :method "run"}
  (dispatch/once (fn [_] (println "first call only"))))
```

### 4) Read/modify locals and fields inside callback

```clojure
(require '[jdi-clj.inspect :as inspect])

(req/breakpoint! session {:class "com.acme.Main" :line 99}
  (fn [{:keys [thread]}]
    (println "x=" (ins/unmirror-value (ins/local-value thread "x")))
    (ins/set-local-value! thread "x" 123)
    (let [self (ins/this-object thread 0)]
      (ins/set-field-value! self "flag" true))))
```

### 5) Dynamic request control

Capture returned handles and toggle/remove later:

```clojure
(def handle (req/exception-breakpoint! session {:class "java.lang.IllegalStateException"} prn))
(req/disable! handle)
(req/enable! handle)
(req/delete! handle)
```

## Full API guidance

For full function reference, see `./full-api.md`.
