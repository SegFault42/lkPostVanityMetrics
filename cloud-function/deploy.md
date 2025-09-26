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


  shared secret '2dc802a2e0d059a5e8aa8c6bf0037fbcef21c3312cd0c4109c0ca20dc2cf6eaf'curl -X 
  
  refresh creators: 
  POST \
  -H "Content-Type: application/json" \
  -H "X-Refresh-Key: 2dc802a2e0d059a5e8aa8c6bf0037fbcef21c3312cd0c4109c0ca20dc2cf6eaf" \
  https://us-central1-linkedincreatorleaderboard.cloudfunctions.net/refreshCreators
