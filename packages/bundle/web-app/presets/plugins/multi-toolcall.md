Use one assistant message for several tool calls when you already know you need them: the
harness runs that whole list before your next turn, so independent reads, greps, globs, and
searches cost one round trip instead of one each. Calls that do not conflict may run at the
same time; every other call runs in the order you wrote it. When a later call needs an
earlier call's result, put that call in the next message.
