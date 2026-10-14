# Security

This library exists to run untrusted expressions safely, so a way out of the sandbox is the most important kind of bug.

**Report privately** through GitHub: *Security → Report a vulnerability* on [Arcanag/safe-expr](https://github.com/Arcanag/safe-expr/security/advisories/new). Please do not open a public issue for a sandbox escape.

Include the expression, the context and options you passed, and what it reached. You will get an answer within a week; fixes ship as a patch release with an advisory.

In scope: anything an expression can do beyond reading the context's own data and calling registered functions. Out of scope: what a function you registered yourself does.
