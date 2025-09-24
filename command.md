python fetch_linkedin_profile_updates.py 'urn:li:fsd_profile:ACoAAByAzQoB9-VHcgJ_Fx6moaCchiwhtPfz7rw' --organization-reactions-only --count 20 --output org-reactions.json


chris;

python fetch_linkedin_profile_updates.py 'urn:li:fsd_profile:ACoAAAZrA6oBIzQ2nZjGxv_F7gi9lDpCuwadYzI' --count 20 --limit 200 --output posts.json --verbose --organization-reactions-only


all posts:

 python fetch_linkedin_profile_updates.py 'urn:li:fsd_profile:ACoAAAZrA6oBIzQ2nZjGxv_F7gi9lDpCuwadYzI' --count all  --output posts.json --verbose --organization-reactions-only


 final clean :

 /fetchv2 'urn:li:fsd_profile:ACoAABSRyhYBt8QgjkT6Jd9OfEDl6f6CKnjGLv8' --count 20 --verbose