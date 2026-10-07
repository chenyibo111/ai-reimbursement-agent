package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

type AdminServices struct { Policies *application.PolicyRuleService; Reviews *application.ReviewCaseService; Role func(context.Context,string)(string,error) }
type adminHandler struct { services AdminServices }
func (handler *adminHandler) authorize(request *http.Request) (Actor,bool) { actor,_:=ActorFromContext(request.Context()); role,err:=handler.services.Role(request.Context(),actor.ID); return actor,err==nil&&(role=="ADMIN"||role=="FINANCE_REVIEWER") }
func (handler *adminHandler) publishPolicy(response http.ResponseWriter, request *http.Request) { actor,ok:=handler.authorize(request);if !ok{writeError(response,http.StatusForbidden,"FORBIDDEN","无财务管理权限");return};var body struct{ID string `json:"id"`;EffectiveDate string `json:"effectiveDate"`};if json.NewDecoder(request.Body).Decode(&body)!=nil||strings.TrimSpace(body.ID)==""{writeError(response,400,"INVALID_REQUEST","政策参数无效");return};if err:=handler.services.Policies.Publish(actor.ID,application.PolicyVersion{ID:body.ID,EffectiveDate:body.EffectiveDate});err!=nil{writeError(response,400,"INVALID_REQUEST",err.Error());return};writeJSON(response,201,map[string]string{"id":body.ID,"status":"PUBLISHED"}) }
func (handler *adminHandler) resolveReview(response http.ResponseWriter, request *http.Request) { actor,ok:=handler.authorize(request);if !ok{writeError(response,403,"FORBIDDEN","无财务复核权限");return};var body struct{Resolution string `json:"resolution"`};if json.NewDecoder(request.Body).Decode(&body)!=nil{writeError(response,400,"INVALID_REQUEST","复核参数无效");return};role,_:=handler.services.Role(request.Context(),actor.ID);if err:=handler.services.Reviews.Resolve(actor.ID,role,request.PathValue("reviewId"),body.Resolution);err!=nil{writeError(response,409,"REVIEW_CASE_UNAVAILABLE",err.Error());return};writeJSON(response,200,map[string]string{"id":request.PathValue("reviewId"),"status":"RESOLVED"}) }
