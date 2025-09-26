gcloud secrets create linkedin-cookie --data-file=cookie.txt
gcloud secrets create linkedin-csrf --data-file=csrf.txt

UPDATE secrets

# Update linkedin-cookie from the new cookie.txt contents
gcloud secrets versions add linkedin-cookie --data-file=cookie.txt

# Update linkedin-csrf from the new csrf.txt contents
gcloud secrets versions add linkedin-csrf --data-file=csrf.txt



 gcloud functions deploy profilePostsFetcher \
  --gen2 \
  --region=us-central1 \
  --runtime=nodejs18 \
  --entry-point=profilePostsFetcher \
  --source=. \
  --trigger-http \
  --allow-unauthenticated \
  --set-secrets=LINKEDIN_COOKIE=linkedin-cookie:latest,LINKEDIN_CSRF_TOKEN=linkedin-csrf:latest 