# jdi-clj full API

This is the complete function map for current public usage.

## jdi-clj.connect

- `(parse-socket-spec spec)`
- `(socket spec)`
- `(process pid-or-opts)`
- `(launch {:main string :options string?})`

## jdi-clj.dispatch

- `(session vm)`
- `(event-context session event)`
- `(once handler)`
- `(add-request-handler! request handler)`
- `(add-global-handler! session handler)`
- `(event! session event)` (dispatch one)
- `(events! session)` (blocking loop)
- `(start! session)` (daemon thread)
- `(stop! session)`

## jdi-clj.requests

### Request lifecycle

- `(handle requests [& {:keys [prepare-request enabled?]}])`
- `(event-requests target)`
- `(set-enabled! target enabled?)`
- `(enable! target)`
- `(disable! target)`
- `(delete! target)`
- `(add-handler! target [opts] handler)` (`opts`: `{:once? boolean}`)

### Low-level request constructors

- `(class-prepare-request! session opts [handler])`
- `(breakpoint-request! session location opts [handler])`
- `(exception-request! session exception-type caught? uncaught? opts [handler])`
- `(method-entry-request! session opts [handler])`
- `(method-exit-request! session opts [handler])`
- `(access-watchpoint-request! session field opts [handler])`
- `(modification-watchpoint-request! session field opts [handler])`
- `(step-request! session thread size depth opts [handler])`
- `(thread-start-request! session opts [handler])`
- `(thread-death-request! session opts [handler])`
- `(vm-death-request! session opts [handler])`
- `(monitor-contended-enter-request! session opts [handler])`
- `(monitor-contended-entered-request! session opts [handler])`
- `(monitor-wait-request! session opts [handler])`
- `(monitor-waited-request! session opts [handler])`

### High-level helpers

- `(for-each-class! session class-name [opts] f)`
- `(breakpoint! session {:class string :line int ...} handler)`
- `(exception-breakpoint! session {:class (nil|string|Class|ReferenceType) :caught? bool :uncaught? bool ...} handler)`
- `(method-entry-breakpoint! session {:class ... :method string :signature string? ...} handler)`
- `(method-exit-breakpoint! session {:class ... :method string :signature string? ...} handler)`
- `(access-watchpoint! session {:class string :field string ...} handler)`
- `(modification-watchpoint! session {:class string :field string ...} handler)`
- `(on-current-method-exit! session thread handler)`
- `(step! session thread size depth opts handler)`
- `(step-into! session thread opts handler)`
- `(step-over! session thread opts handler)`
- `(step-out! session thread opts handler)`
- `(print-trace! ctx [message writer])`
- `(full-method-name method)`

## jdi-clj.inspect

- `(frame thread [depth])`
- `(this-object thread [depth])`
- `(visible-locals thread [depth])`
- `(local-value thread [depth] local-name)`
- `(set-local-value! thread [depth] local-name value)`
- `(field reference-type field-name)`
- `(field-value target field-name)`
- `(set-field-value! target field-name value)`
- `(mirror-value vm x)`
- `(unmirror-value value)`
- `(choose-method type method-name argc {:keys [signature static?]})`
- `(invoke-instance-method thread object method-name args [opts])`
- `(invoke-static thread class-type method-name args [opts])`
- `(new-instance thread class-type args [opts])`
- `(dump-thread thread)`
