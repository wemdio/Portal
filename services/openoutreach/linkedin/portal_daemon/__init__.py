"""
Portal-native multi-tenant daemon для OpenOutreach.

См. UPSTREAM.md / docs/superpowers/specs/2026-06-10-openoutreach-portal-native-design.md.

Точка входа — `main_loop.run_forever()`, дёргается через
`manage.py rundaemon` (см. linkedin/management/commands/rundaemon.py).
"""
