import os
print('cookie', bool(os.getenv('LINKEDIN_COOKIE')))
print('csrf', os.getenv('LINKEDIN_CSRF_TOKEN'))
