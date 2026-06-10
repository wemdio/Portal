# linkedin/urls.py
#
# Portal-native fork: Django Admin отключён (Portal UI достаточен).
# Этот процесс вообще не сервит HTTP — `manage.py rundaemon` крутит async
# main loop. urls.py остаётся файлом только потому, что Django требует
# ROOT_URLCONF для bootstrap'a; реальных endpoint'ов нет.

urlpatterns: list = []
